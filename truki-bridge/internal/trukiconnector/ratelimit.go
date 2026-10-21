// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package trukiconnector

import (
	"errors"

	"go.mau.fi/mautrix-meta/pkg/messagix/httpclient"
	"go.mau.fi/whatsmeow"
)

// whatsmeowAck429 is the text of the error whatsmeow returns when the
// server acks a sent message with error code 429: send.go and sendfb.go
// build it as fmt.Errorf("%w %d", ErrServerReturnedError, code), so the
// code exists only in the text.
var whatsmeowAck429 = whatsmeow.ErrServerReturnedError.Error() + " 429"

// whatsmeowUpload429 is the text of the (unwrapped) error whatsmeow's
// media upload returns for an HTTP 429 (upload.go).
const whatsmeowUpload429 = "upload failed with status code 429"

// isNetworkRateLimit reports whether a send error from a real network
// connector is a rate limit:
//   - WhatsApp, and Messenger's encrypted chats (whatsmeow): a message ack
//     with error 429, an info query answered 429 rate-overlimit, or a
//     media upload answered HTTP 429.
//   - Facebook Messenger and Instagram (messagix): an HTTP 429, also after
//     the client's own retries gave up.
func isNetworkRateLimit(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, whatsmeow.ErrIQRateOverLimit) || errors.Is(err, httpclient.ErrRateLimited) {
		return true
	}
	return anyInChain(err, func(e error) bool {
		if e.Error() == whatsmeowUpload429 {
			return true
		}
		return errors.Unwrap(e) == whatsmeow.ErrServerReturnedError && e.Error() == whatsmeowAck429
	})
}

// anyInChain reports whether match holds for err or any error it wraps,
// following both Unwrap() error and Unwrap() []error.
func anyInChain(err error, match func(error) bool) bool {
	if err == nil {
		return false
	}
	if match(err) {
		return true
	}
	switch u := err.(type) {
	case interface{ Unwrap() error }:
		return anyInChain(u.Unwrap(), match)
	case interface{ Unwrap() []error }:
		for _, e := range u.Unwrap() {
			if anyInChain(e, match) {
				return true
			}
		}
	}
	return false
}
