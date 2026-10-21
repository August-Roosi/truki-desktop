// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package rpc

import (
	"errors"
	"fmt"
)

// ProtocolVersion is the wire protocol version implemented by this bridge.
const ProtocolVersion = 1

// Truki error codes, carried in the JSON-RPC error object's data.code.
const (
	CodeNotInitialized = "NOT_INITIALIZED"
	CodeInvalidInput   = "INVALID_INPUT"
	CodeNotFound       = "NOT_FOUND"
	CodeInternal       = "INTERNAL"
)

// Error is a bridge-level error. Code is one of the Code* constants and
// travels to the client as error.data.code in the JSON-RPC response.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Errf builds an *Error with a formatted message.
func Errf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// trukiError converts a handler error into an *Error. Errors that are not
// already *Error become INTERNAL.
func trukiError(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return Errf(CodeInternal, "%v", err)
}
