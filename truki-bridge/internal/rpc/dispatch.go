// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package rpc

import (
	"context"
	"encoding/json"
	"runtime/debug"
)

// JSON-RPC 2.0 error codes used by the transport.
const (
	jsonRPCParseError     = -32700
	jsonRPCInvalidRequest = -32600
	jsonRPCMethodNotFound = -32601
	jsonRPCInvalidParams  = -32602
	jsonRPCServerErr      = -32000
)

// request is an incoming JSON-RPC message. A missing id means the peer
// sent a notification.
type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

// jsonRPCCode maps a Truki error code to a JSON-RPC 2.0 code. Every Truki
// code other than INVALID_INPUT shares the generic -32000 server code.
func jsonRPCCode(trukiCode string) int {
	if trukiCode == CodeInvalidInput {
		return jsonRPCInvalidParams
	}
	return jsonRPCServerErr
}

// dispatch parses one input line and routes it. The handshake and the
// pre-init gate stay synchronous: a successful init must complete before
// anything else is dispatched. After that every request and notification
// is dispatched in its own goroutine, so a slow handler never blocks
// reading and answering the rest of the stream.
func (c *Conn) dispatch(ctx context.Context, line []byte) {
	var req request
	if err := json.Unmarshal(line, &req); err != nil {
		c.log.Debug().Err(err).Msg("malformed JSON-RPC line")
		c.sendError(nil, CodeInvalidInput, jsonRPCParseError, "parse error: "+err.Error())
		return
	}
	if req.Method == "" {
		if len(req.ID) > 0 {
			c.sendError(req.ID, CodeInvalidInput, jsonRPCInvalidRequest,
				"invalid request: missing method")
		}
		return
	}

	if req.Method == methodInit {
		c.dispatchInit(ctx, &req)
		return
	}
	if !c.isInitialized() {
		e := Errf(CodeNotInitialized, "init required before method %q", req.Method)
		if len(req.ID) == 0 {
			c.log.Warn().Str("method", req.Method).Str("code", e.Code).
				Msg("notification dispatch failed")
			return
		}
		c.sendError(req.ID, e.Code, jsonRPCCode(e.Code), e.Message)
		return
	}

	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		defer c.recoverHandler(&req)
		c.runHandler(ctx, &req)
	}()
}

// dispatchInit performs the handshake synchronously and answers it.
func (c *Conn) dispatchInit(ctx context.Context, req *request) {
	defer c.recoverHandler(req)

	if c.initHandler() == nil {
		e := Errf(CodeInvalidInput, "method not found: %q", req.Method)
		if len(req.ID) > 0 {
			c.sendError(req.ID, e.Code, jsonRPCMethodNotFound, e.Message)
		}
		return
	}
	res, rerr := c.callInit(ctx, req)
	if len(req.ID) == 0 {
		return
	}
	if rerr != nil {
		c.sendError(req.ID, rerr.Code, jsonRPCCode(rerr.Code), rerr.Message)
		return
	}
	c.sendResult(req.ID, res)
}

// runHandler executes one dispatched method after init and answers the
// request; a failing notification is only logged.
func (c *Conn) runHandler(ctx context.Context, req *request) {
	h := c.lookupHandler(req.Method)
	if h == nil {
		e := Errf(CodeInvalidInput, "method not found: %q", req.Method)
		if len(req.ID) == 0 {
			c.log.Warn().Str("method", req.Method).Str("code", e.Code).
				Msg("notification dispatch failed")
			return
		}
		c.sendError(req.ID, e.Code, jsonRPCMethodNotFound, e.Message)
		return
	}
	res, err := h(ctx, req.Params)
	if len(req.ID) == 0 {
		if err != nil {
			c.log.Warn().Str("method", req.Method).Str("code", trukiError(err).Code).
				Msg("notification dispatch failed")
		}
		return
	}
	if err != nil {
		e := trukiError(err)
		if e.Code == CodeInternal {
			c.log.Error().Err(err).Str("method", req.Method).Msg("handler error")
		} else {
			c.log.Warn().Err(err).Str("method", req.Method).Msg("handler error")
		}
		c.sendError(req.ID, e.Code, jsonRPCCode(e.Code), e.Message)
		return
	}
	c.sendResult(req.ID, res)
}

// recoverHandler is deferred around every handler call. A panicking handler
// is answered with INTERNAL and logged with its stack; serving continues.
func (c *Conn) recoverHandler(req *request) {
	if r := recover(); r != nil {
		c.log.Error().Str("method", req.Method).Interface("panic", r).
			Bytes("stack", debug.Stack()).Msg("handler panicked")
		if len(req.ID) > 0 {
			c.sendError(req.ID, CodeInternal, jsonRPCServerErr, "internal error")
		}
	}
}

// callInit performs the handshake. A protocolVersion mismatch is rejected
// without calling the registered init handler; the connection is marked
// initialized only when the handler succeeds.
func (c *Conn) callInit(ctx context.Context, req *request) (*InitResult, *Error) {
	if c.isInitialized() {
		return nil, Errf(CodeInvalidInput, "init already completed")
	}
	if len(req.Params) == 0 {
		return nil, Errf(CodeInvalidInput, "init requires params")
	}
	var p InitParams
	if err := json.Unmarshal(req.Params, &p); err != nil {
		return nil, Errf(CodeInvalidInput, "bad init params: %v", err)
	}
	if p.ProtocolVersion != ProtocolVersion {
		return nil, Errf(CodeInvalidInput, "unsupported protocolVersion %d, want %d",
			p.ProtocolVersion, ProtocolVersion)
	}
	res, err := c.initHandler()(ctx, p)
	if err != nil {
		return nil, trukiError(err)
	}
	c.setInitialized()
	return res, nil
}
