// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"testing"

	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/status"
)

func accountStateParams(t *testing.T, st status.BridgeState) map[string]any {
	t.Helper()
	var got map[string]any
	s := NewSink(func(method string, params any) {
		if method != "event.accountState" {
			t.Fatalf("method = %q", method)
		}
		got = params.(map[string]any)
	}, nil)
	s.AccountState("whatsapp", st)
	return got
}

func TestAccountStateReason(t *testing.T) {
	p := accountStateParams(t, status.BridgeState{
		RemoteID:   networkid.UserLoginID("l1"),
		StateEvent: status.StateBadCredentials,
		Error:      "wa-logged-out",
		Message:    "You were logged out from another device",
	})
	if p["reason"] != "wa-logged-out: You were logged out from another device" {
		t.Errorf("reason = %v", p["reason"])
	}
	if p["state"] != "BAD_CREDENTIALS" || p["loginId"] != "l1" {
		t.Errorf("params = %v", p)
	}

	p = accountStateParams(t, status.BridgeState{
		RemoteID: "l1", StateEvent: status.StateUnknownError, Error: "some-code",
	})
	if p["reason"] != "some-code" {
		t.Errorf("code only: reason = %v", p["reason"])
	}
	p = accountStateParams(t, status.BridgeState{
		RemoteID: "l1", StateEvent: status.StateUnknownError, Message: "just text",
	})
	if p["reason"] != "just text" {
		t.Errorf("message only: reason = %v", p["reason"])
	}
}

func TestAccountStateNoReasonWhenNone(t *testing.T) {
	for _, st := range []status.BridgeState{
		{StateEvent: status.StateStarting},
		{RemoteID: "l1", StateEvent: status.StateConnected},
	} {
		if _, ok := accountStateParams(t, st)["reason"]; ok {
			t.Errorf("%+v: reason present", st)
		}
	}
}

func TestTruncateRunes(t *testing.T) {
	for _, c := range []struct {
		in   string
		n    int
		want string
	}{
		{"", 3, ""},
		{"abc", 3, "abc"},
		{"abcd", 3, "abc"},
		{"äöüõ", 2, "äö"},
	} {
		if got := truncateRunes(c.in, c.n); got != c.want {
			t.Errorf("truncateRunes(%q, %d) = %q; want %q", c.in, c.n, got, c.want)
		}
	}
}
