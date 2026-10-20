// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Package rpc implements the newline-delimited JSON-RPC 2.0 transport
// between Truki's Electron main process and the truki-bridge child process.
package rpc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"

	"github.com/rs/zerolog"
)

// Handler serves one JSON-RPC method. params is the raw params value and may
// be nil when the request carried no params at all.
type Handler func(ctx context.Context, params json.RawMessage) (any, error)

// maxLine caps one JSON-RPC line at 16 MiB.
const maxLine = 16 << 20

// methodInit is the handshake method, handled by Conn itself.
const methodInit = "init"

// InitParams are the handshake parameters sent by Truki.
type InitParams struct {
	ProtocolVersion int    `json:"protocolVersion"`
	DataDir         string `json:"dataDir"`
	DBKey           string `json:"dbKey"` // hex, 64 chars; validated by the init handler
}

// NetworkInfo identifies one network served by the bridge.
type NetworkInfo struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// InitResult is the handshake response.
type InitResult struct {
	ProtocolVersion int           `json:"protocolVersion"`
	BridgeVersion   string        `json:"bridgeVersion"`
	Networks        []NetworkInfo `json:"networks"`
}

// Conn is a JSON-RPC 2.0 connection over a pair of streams.
type Conn struct {
	r   *bufio.Reader
	w   io.Writer
	log zerolog.Logger

	// wmu serializes writes so every message is one intact line.
	wmu sync.Mutex

	// wg tracks in-flight handler goroutines; Serve waits for them
	// before returning.
	wg sync.WaitGroup

	mu          sync.Mutex
	handlers    map[string]Handler
	initFn      func(ctx context.Context, p InitParams) (*InitResult, error)
	initialized bool
}

// NewConn creates a Conn reading JSON-RPC messages from r and writing them
// to w. Nothing is read or written until Serve is called.
func NewConn(r io.Reader, w io.Writer, log zerolog.Logger) *Conn {
	return &Conn{
		r:        bufio.NewReaderSize(r, 64*1024),
		w:        w,
		log:      log,
		handlers: make(map[string]Handler),
	}
}

// Handle registers a method handler. Registering "init" panics: the
// handshake is wired with HandleInit.
func (c *Conn) Handle(method string, h Handler) {
	if method == methodInit {
		panic("rpc: init is handled via HandleInit")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.handlers[method] = h
}

// HandleInit registers the handshake handler. Conn performs the
// protocolVersion check itself and marks the connection initialized only
// when fn returns no error.
func (c *Conn) HandleInit(fn func(ctx context.Context, p InitParams) (*InitResult, error)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.initFn = fn
}

// Notify sends a notification (no id, no response) to the peer. It is safe
// for concurrent use and blocks only for the duration of one line write.
func (c *Conn) Notify(method string, params any) {
	if err := c.writeJSON(notification{JSONRPC: "2.0", Method: method, Params: params}); err != nil {
		c.log.Error().Err(err).Str("method", method).Msg("notify write failed")
	}
}

// Serve reads and dispatches newline-delimited JSON-RPC messages until EOF
// or ctx is done. The context is checked between messages; a blocked read
// ends when the peer closes the stream. After a successful init each request
// is dispatched in its own goroutine with a context derived from ctx: Serve
// cancels that context and waits for in-flight handlers before returning.
func (c *Conn) Serve(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer c.wg.Wait()
	defer cancel()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		line, err := c.readLine()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if errors.Is(err, errLineTooLong) {
			c.sendError(nil, CodeInvalidInput, jsonRPCInvalidParams,
				"request line exceeds the 16 MiB cap")
			continue
		}
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
		c.dispatch(ctx, line)
	}
}

// errLineTooLong reports that a line exceeded maxLine and was discarded.
var errLineTooLong = errors.New("rpc: line exceeds the 16 MiB cap")

// readLine returns the next complete line including its '\n'. Lines longer
// than maxLine are discarded whole and reported as errLineTooLong.
func (c *Conn) readLine() ([]byte, error) {
	var line []byte
	for {
		chunk, err := c.r.ReadSlice('\n')
		if err == bufio.ErrBufferFull {
			line = append(line, chunk...)
			if len(line) > maxLine {
				_ = c.discardLine()
				return nil, errLineTooLong
			}
			continue
		}
		if err != nil && err != io.EOF {
			return nil, err
		}
		line = append(line, chunk...)
		if len(line) == 0 {
			return nil, io.EOF
		}
		return line, nil
	}
}

// discardLine drains the rest of an oversized line up to its '\n'.
func (c *Conn) discardLine() error {
	for {
		_, err := c.r.ReadSlice('\n')
		if err == bufio.ErrBufferFull {
			continue
		}
		return err
	}
}

func (c *Conn) lookupHandler(method string) Handler {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.handlers[method]
}

func (c *Conn) initHandler() func(ctx context.Context, p InitParams) (*InitResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.initFn
}

func (c *Conn) isInitialized() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.initialized
}

func (c *Conn) setInitialized() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.initialized = true
}

type notification struct {
	JSONRPC string `json:"jsonrpc"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type resultResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result"`
}

type errorResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Error   wireError       `json:"error"`
}

type wireError struct {
	Code    int           `json:"code"`
	Message string        `json:"message"`
	Data    wireErrorData `json:"data"`
}

type wireErrorData struct {
	Code string `json:"code"`
}

// writeJSON marshals v and writes it as one line.
func (c *Conn) writeJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_, err = c.w.Write(b)
	return err
}

func (c *Conn) sendResult(id json.RawMessage, result any) {
	if err := c.writeJSON(resultResponse{JSONRPC: "2.0", ID: id, Result: result}); err != nil {
		c.log.Error().Err(err).Msg("response write failed")
	}
}

func (c *Conn) sendError(id json.RawMessage, trukiCode string, jsonrpcCode int, message string) {
	if err := c.writeJSON(errorResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error:   wireError{Code: jsonrpcCode, Message: message, Data: wireErrorData{Code: trukiCode}},
	}); err != nil {
		c.log.Error().Err(err).Msg("error response write failed")
	}
}
