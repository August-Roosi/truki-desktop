// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package trukiconnector

import (
	"errors"
	"fmt"
	"testing"

	"go.mau.fi/mautrix-meta/pkg/messagix/httpclient"
	"go.mau.fi/whatsmeow"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/event"
)

// failedStatus builds the message status bridgev2 reports for a send that
// returned err (Portal.sendErrorStatus).
func failedStatus(err error) *bridgev2.MessageStatus {
	ms := bridgev2.WrapErrorInStatus(err)
	if ms.ErrorReason == "" {
		ms.ErrorReason = event.MessageStatusGenericError
	}
	if ms.InternalError == nil {
		ms.InternalError = err
	}
	return &ms
}

// TestRateLimitWhatsApp uses the errors whatsmeow builds: a message ack with
// error 429 (send.go, sendfb.go: fmt.Errorf("%w %d", ErrServerReturnedError,
// code)), an info query answered 429 rate-overlimit (the device-list lookup
// before a send), and a media upload answered HTTP 429 (upload.go, an
// unwrapped "upload failed with status code %d").
func TestRateLimitWhatsApp(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"ack 429", fmt.Errorf("%w %d", whatsmeow.ErrServerReturnedError, 429), CodeRateLimited},
		{"wrapped ack 429", fmt.Errorf("send: %w", fmt.Errorf("%w %d", whatsmeow.ErrServerReturnedError, 429)), CodeRateLimited},
		{"iq rate-overlimit", fmt.Errorf("failed to get device list: %w", &whatsmeow.IQError{Code: 429, Text: "rate-overlimit"}), CodeRateLimited},
		{"upload 429", fmt.Errorf("failed to upload media: %w", fmt.Errorf("upload failed with status code %d", 429)), CodeRateLimited},
		{"ack 479", fmt.Errorf("%w %d", whatsmeow.ErrServerReturnedError, 479), string(event.MessageStatusGenericError)},
		{"ack 4290", fmt.Errorf("%w %d", whatsmeow.ErrServerReturnedError, 4290), string(event.MessageStatusGenericError)},
		{"iq forbidden", whatsmeow.ErrIQForbidden, string(event.MessageStatusGenericError)},
		{"upload 500", fmt.Errorf("upload failed with status code %d", 500), string(event.MessageStatusGenericError)},
	}
	for _, c := range cases {
		if got := errorCode(failedStatus(c.err)); got != c.want {
			t.Errorf("%s (%v): code %q; want %q", c.name, c.err, got, c.want)
		}
	}
}

// TestRateLimitMeta covers Facebook Messenger and Instagram, which share
// messagix's HTTP client: an HTTP 429 is httpclient.ErrRateLimited, also
// after the client's own retries give up (ErrMaxRetriesReached wraps it).
// Messenger's end-to-end encrypted chats send through whatsmeow, so the
// WhatsApp ack 429 applies to them too.
func TestRateLimitMeta(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"http 429", httpclient.ErrRateLimited, CodeRateLimited},
		{"upload 429", fmt.Errorf("failed to convert message: %w", httpclient.ErrRateLimited), CodeRateLimited},
		{"retries exhausted on 429", fmt.Errorf("%w: %w", httpclient.ErrMaxRetriesReached, httpclient.ErrRateLimited), CodeRateLimited},
		{"e2ee ack 429", fmt.Errorf("%w %d", whatsmeow.ErrServerReturnedError, 429), CodeRateLimited},
		{"http 500", fmt.Errorf("%w %d", httpclient.ErrUnexpectedError, 500), string(event.MessageStatusGenericError)},
		{"other", errors.New("server rejected message"), string(event.MessageStatusGenericError)},
	}
	for _, c := range cases {
		if got := errorCode(failedStatus(c.err)); got != c.want {
			t.Errorf("%s (%v): code %q; want %q", c.name, c.err, got, c.want)
		}
	}
}
