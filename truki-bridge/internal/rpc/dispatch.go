// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package rpc

import (
	"context"
	"encoding/json"
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

// dispatch parses one input line and routes it.
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

	result, rerr, jsonrpcCode := c.route(ctx, &req)
	if len(req.ID) == 0 {
		// A notification from the peer: dispatched, never answered.
		if rerr != nil {
			c.log.Warn().Str("method", req.Method).Str("code", rerr.Code).
				Msg("notification dispatch failed")
		}
		return
	}
	if rerr != nil {
		c.sendError(req.ID, rerr.Code, jsonrpcCode, rerr.Message)
		return
	}
	c.sendResult(req.ID, result)
}

// route runs the method and returns its result or error plus the
// JSON-RPC code to use when answering.
func (c *Conn) route(ctx context.Context, req *request) (any, *Error, int) {
	if req.Method == methodInit {
		if c.initHandler() == nil {
			e := Errf(CodeInvalidInput, "method not found: %q", req.Method)
			return nil, e, jsonRPCMethodNotFound
		}
		res, err := c.callInit(ctx, req)
		if err != nil {
			return nil, err, jsonRPCCode(err.Code)
		}
		return res, nil, 0
	}
	if !c.isInitialized() {
		e := Errf(CodeNotInitialized, "init required before method %q", req.Method)
		return nil, e, jsonRPCCode(e.Code)
	}
	h := c.lookupHandler(req.Method)
	if h == nil {
		e := Errf(CodeInvalidInput, "method not found: %q", req.Method)
		return nil, e, jsonRPCMethodNotFound
	}
	res, err := h(ctx, req.Params)
	if err != nil {
		e := trukiError(err)
		if e.Code == CodeInternal {
			c.log.Error().Err(err).Str("method", req.Method).Msg("handler error")
		} else {
			c.log.Warn().Err(err).Str("method", req.Method).Msg("handler error")
		}
		return nil, e, jsonRPCCode(e.Code)
	}
	return res, nil, 0
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
