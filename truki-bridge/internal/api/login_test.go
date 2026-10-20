// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"testing"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/faketest"
)

func TestLoginOverRPC(t *testing.T) {
	e := newEnv(t)

	r := e.call("login.flows", map[string]any{"network": "fake"})
	var flows []struct{ ID, Name, Description string }
	if err := json.Unmarshal(r.Result, &flows); err != nil || len(flows) != 1 || flows[0].ID != "fake" {
		t.Fatalf("login.flows = %s / %v; want only the fake flow", r.Result, err)
	}

	e.wantError(e.call("login.start", map[string]any{"network": "fake", "flowId": faketest.QRFlowID}), "INVALID_INPUT")
	e.wantError(e.call("login.start", map[string]any{"network": "fake", "flowId": "fake", "extra": 1}), "INVALID_INPUT")
	e.wantError(e.call("login.start", map[string]any{"network": "nope", "flowId": "fake"}), "NOT_FOUND")

	r = e.call("login.start", map[string]any{"network": "fake", "flowId": "fake"})
	var start struct {
		ProcessID string `json:"processId"`
		Step      struct {
			Type   string `json:"type"`
			StepID string `json:"step_id"`
		} `json:"step"`
	}
	if err := json.Unmarshal(r.Result, &start); err != nil || start.ProcessID == "" || start.Step.Type != "user_input" {
		t.Fatalf("login.start = %s / %v; want a user_input step", r.Result, err)
	}
	r = e.call("login.submit", map[string]any{"processId": start.ProcessID, "stepId": start.Step.StepID, "input": map[string]string{"username": "bob"}})
	var sub struct {
		Step struct {
			Type string `json:"type"`
		} `json:"step"`
	}
	if err := json.Unmarshal(r.Result, &sub); err != nil || sub.Step.Type != "complete" {
		t.Fatalf("login.submit = %s / %v; want complete", r.Result, err)
	}

	r = e.call("accounts.list", nil)
	var accts []struct {
		LoginID, Network string
	}
	if err := json.Unmarshal(r.Result, &accts); err != nil || len(accts) != 2 {
		t.Fatalf("accounts.list = %s / %v; want alice and bob", r.Result, err)
	}
	if r := e.call("accounts.logout", map[string]any{"loginId": "bob"}); r.Error != nil {
		t.Fatalf("accounts.logout: %+v", r.Error)
	}
	e.wantError(e.call("accounts.logout", map[string]any{"loginId": "bob"}), "NOT_FOUND")

	start2 := e.call("login.start", map[string]any{"network": "fake", "flowId": "fake"})
	if err := json.Unmarshal(start2.Result, &start); err != nil {
		t.Fatal(err)
	}
	if r := e.call("login.cancel", map[string]any{"processId": start.ProcessID}); r.Error != nil {
		t.Fatalf("login.cancel: %+v", r.Error)
	}
	e.wantError(e.call("login.cancel", map[string]any{"processId": start.ProcessID}), "NOT_FOUND")
}
