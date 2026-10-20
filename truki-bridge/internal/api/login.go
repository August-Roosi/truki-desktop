// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"bytes"
	"context"
	"encoding/json"

	"github.com/rs/zerolog"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/host"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/login"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/rpc"
)

// registerLogin installs the login.* and accounts.* methods.
func registerLogin(conn *rpc.Conn, h *host.Host) {
	m := login.NewManager(h, conn.Notify, zerolog.Nop())

	conn.Handle("login.flows", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			Network string `json:"network"`
		}
		if err := strictParams(raw, &p); err != nil {
			return nil, err
		}
		return m.Flows(ctx, p.Network)
	})
	conn.Handle("login.start", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			Network string `json:"network"`
			FlowID  string `json:"flowId"`
		}
		if err := strictParams(raw, &p); err != nil {
			return nil, err
		}
		return m.Start(ctx, p.Network, p.FlowID)
	})
	conn.Handle("login.submit", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			ProcessID string            `json:"processId"`
			StepID    string            `json:"stepId"`
			Input     map[string]string `json:"input"`
			Cookies   map[string]string `json:"cookies"`
		}
		if err := strictParams(raw, &p); err != nil {
			return nil, err
		}
		res, err := m.Submit(ctx, login.SubmitParams{ProcessID: p.ProcessID, StepID: p.StepID, Input: p.Input, Cookies: p.Cookies})
		if err != nil {
			return nil, err
		}
		return map[string]any{"step": res.Step, "seq": res.Seq}, nil
	})
	conn.Handle("login.cancel", func(_ context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			ProcessID string `json:"processId"`
		}
		if err := strictParams(raw, &p); err != nil {
			return nil, err
		}
		if err := m.Cancel(p.ProcessID); err != nil {
			return nil, err
		}
		return map[string]any{}, nil
	})
	conn.Handle("accounts.list", func(ctx context.Context, _ json.RawMessage) (any, error) {
		return m.Accounts(ctx)
	})
	conn.Handle("accounts.logout", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			LoginID string `json:"loginId"`
			Network string `json:"network"`
		}
		if err := strictParams(raw, &p); err != nil {
			return nil, err
		}
		if p.LoginID == "" {
			return nil, rpc.Errf(rpc.CodeInvalidInput, "loginId is required")
		}
		if err := m.Logout(ctx, p.Network, p.LoginID); err != nil {
			return nil, err
		}
		return map[string]any{}, nil
	})
}

// strictParams decodes required params into dst, rejecting unknown fields.
func strictParams(raw json.RawMessage, dst any) error {
	if len(raw) == 0 {
		return rpc.Errf(rpc.CodeInvalidInput, "params are required")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return rpc.Errf(rpc.CodeInvalidInput, "invalid params: %v", err)
	}
	return nil
}
