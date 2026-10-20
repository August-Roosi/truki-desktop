// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Package api registers the bridge's RPC methods.
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	"maunium.net/go/mautrix/id"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/host"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/rpc"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/store"
)

// Register installs the method handlers on conn. st is the store the host
// was built with; the methods here reach it through h.
func Register(conn *rpc.Conn, h *host.Host, _ *store.Store) {
	registerLogin(conn, h)
	conn.Handle("messages.send", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			ChatID      id.RoomID  `json:"chatId"`
			Text        string     `json:"text"`
			HTML        string     `json:"html"`
			ReplyTo     id.EventID `json:"replyTo"`
			Attachments []struct {
				Path     string `json:"path"`
				Name     string `json:"name"`
				MimeType string `json:"mimeType"`
			} `json:"attachments"`
		}
		if err := parse(raw, &p, &p.ChatID); err != nil {
			return nil, err
		}
		req := host.SendRequest{ChatID: p.ChatID, Text: p.Text, HTML: p.HTML, ReplyTo: p.ReplyTo}
		for _, a := range p.Attachments {
			req.Attachments = append(req.Attachments, host.Attachment{Path: a.Path, Name: a.Name, MimeType: a.MimeType})
		}
		evID, err := h.Send(ctx, req)
		if err != nil {
			return nil, mapErr(err)
		}
		return map[string]any{"eventId": evID}, nil
	})
	conn.Handle("messages.react", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			ChatID  id.RoomID  `json:"chatId"`
			EventID id.EventID `json:"eventId"`
			Key     string     `json:"key"`
		}
		if err := parse(raw, &p, &p.ChatID); err != nil {
			return nil, err
		}
		evID, err := h.React(ctx, p.ChatID, p.EventID, p.Key)
		if err != nil {
			return nil, mapErr(err)
		}
		return map[string]any{"eventId": evID}, nil
	})
	conn.Handle("messages.redact", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			ChatID  id.RoomID  `json:"chatId"`
			EventID id.EventID `json:"eventId"`
		}
		if err := parse(raw, &p, &p.ChatID); err != nil {
			return nil, err
		}
		if err := h.Redact(ctx, p.ChatID, p.EventID); err != nil {
			return nil, mapErr(err)
		}
		return map[string]any{}, nil
	})
	conn.Handle("chats.markRead", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			ChatID  id.RoomID  `json:"chatId"`
			EventID id.EventID `json:"eventId"`
		}
		if err := parse(raw, &p, &p.ChatID); err != nil {
			return nil, err
		}
		if err := h.MarkRead(ctx, p.ChatID, p.EventID); err != nil {
			return nil, mapErr(err)
		}
		return map[string]any{}, nil
	})
	conn.Handle("chats.setMuted", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			ChatID id.RoomID `json:"chatId"`
			Until  *string   `json:"until"`
		}
		if err := parse(raw, &p, &p.ChatID); err != nil {
			return nil, err
		}
		var until time.Time
		if p.Until != nil {
			var err error
			if until, err = time.Parse(time.RFC3339, *p.Until); err != nil {
				return nil, rpc.Errf(rpc.CodeInvalidInput, "until must be RFC 3339: %v", err)
			}
		}
		if err := h.SetMuted(ctx, p.ChatID, until); err != nil {
			return nil, mapErr(err)
		}
		return map[string]any{}, nil
	})
}

// parse decodes params into dst, rejecting unknown fields and a missing
// chatId.
func parse(raw json.RawMessage, dst any, chatID *id.RoomID) error {
	if len(raw) == 0 {
		return rpc.Errf(rpc.CodeInvalidInput, "params are required")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return rpc.Errf(rpc.CodeInvalidInput, "invalid params: %v", err)
	}
	if *chatID == "" {
		return rpc.Errf(rpc.CodeInvalidInput, "chatId is required")
	}
	return nil
}

// mapErr turns host errors into RPC errors.
func mapErr(err error) error {
	switch {
	case errors.Is(err, host.ErrChatNotFound), errors.Is(err, host.ErrEventNotFound):
		return rpc.Errf(rpc.CodeNotFound, "%v", err)
	case errors.Is(err, host.ErrInvalidInput):
		return rpc.Errf(rpc.CodeInvalidInput, "%v", err)
	default:
		return err
	}
}
