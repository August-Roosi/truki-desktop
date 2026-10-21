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
// was built with; the read-side methods read it directly, the rest reach
// it through h.
func Register(conn *rpc.Conn, h *host.Host, st *store.Store) {
	registerLogin(conn, h)
	registerRead(conn, h, st)
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

// decodeParams decodes entirely optional params into dst, rejecting
// unknown fields. Absent or null params leave dst untouched.
func decodeParams(raw json.RawMessage, dst any) error {
	if len(raw) == 0 {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return rpc.Errf(rpc.CodeInvalidInput, "invalid params: %v", err)
	}
	return nil
}

// clampLimit bounds a list limit: n <= 0 means the default, values above
// max are clamped (not an error).
func clampLimit(n, def, max int) int {
	if n <= 0 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

// registerRead installs the read-side methods: networks.list, chats.list,
// chats.get, messages.list, media.path and search.
func registerRead(conn *rpc.Conn, h *host.Host, st *store.Store) {
	conn.Handle("networks.list", func(ctx context.Context, _ json.RawMessage) (any, error) {
		defs := h.Defs()
		out := make([]networkOut, 0, len(defs))
		for _, d := range defs {
			// enabled is "has a logged-in account", read from the database
			// exactly as Host.Start decides which bridges to run — not
			// "bridge is running", which a login flow starts and a logout
			// leaves behind.
			enabled, err := h.HasLogins(ctx, d.ID)
			if err != nil {
				return nil, err
			}
			out = append(out, networkOut{ID: d.ID, Name: d.Name, Enabled: enabled})
		}
		return out, nil
	})
	conn.Handle("chats.list", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			Cursor string `json:"cursor"`
			Limit  int    `json:"limit"`
		}
		if err := decodeParams(raw, &p); err != nil {
			return nil, err
		}
		chats, next, err := st.ListChats(ctx, p.Cursor, clampLimit(p.Limit, 50, 200))
		if err != nil {
			if errors.Is(err, store.ErrBadCursor) {
				return nil, rpc.Errf(rpc.CodeInvalidInput, "%v", err)
			}
			return nil, err
		}
		out := make([]chatOut, 0, len(chats))
		for _, c := range chats {
			out = append(out, newChatOut(c))
		}
		return map[string]any{"chats": out, "nextCursor": next}, nil
	})
	conn.Handle("chats.get", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			ChatID id.RoomID `json:"chatId"`
		}
		if err := parse(raw, &p, &p.ChatID); err != nil {
			return nil, err
		}
		chat, err := st.GetChat(ctx, p.ChatID)
		if err != nil {
			return nil, err
		}
		if chat == nil {
			return nil, rpc.Errf(rpc.CodeNotFound, "chat %s not found", p.ChatID)
		}
		members, err := st.GetMembers(ctx, p.ChatID)
		if err != nil {
			return nil, err
		}
		return map[string]any{"chat": newChatOut(chat), "members": members}, nil
	})
	conn.Handle("messages.list", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			ChatID id.RoomID `json:"chatId"`
			Before *int64    `json:"before"`
			Limit  int       `json:"limit"`
		}
		if err := parse(raw, &p, &p.ChatID); err != nil {
			return nil, err
		}
		chat, err := st.GetChat(ctx, p.ChatID)
		if err != nil {
			return nil, err
		}
		if chat == nil {
			return nil, rpc.Errf(rpc.CodeNotFound, "chat %s not found", p.ChatID)
		}
		var before int64
		if p.Before != nil {
			before = *p.Before
		}
		events, err := st.ListEvents(ctx, p.ChatID, before, clampLimit(p.Limit, 50, 200))
		if err != nil {
			return nil, err
		}
		return map[string]any{"events": newEventOuts(events)}, nil
	})
	conn.Handle("media.path", func(_ context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			MediaID string `json:"mediaId"`
		}
		if err := strictParams(raw, &p); err != nil {
			return nil, err
		}
		if p.MediaID == "" {
			return nil, rpc.Errf(rpc.CodeInvalidInput, "mediaId is required")
		}
		path, err := h.MediaPath(p.MediaID)
		if err != nil {
			return nil, mapErr(err)
		}
		return map[string]any{"path": path}, nil
	})
	conn.Handle("search", func(ctx context.Context, raw json.RawMessage) (any, error) {
		var p struct {
			Query string `json:"query"`
			Limit int    `json:"limit"`
		}
		if err := strictParams(raw, &p); err != nil {
			return nil, err
		}
		if p.Query == "" {
			return nil, rpc.Errf(rpc.CodeInvalidInput, "query is required")
		}
		events, err := st.Search(ctx, p.Query, clampLimit(p.Limit, 20, 100))
		if err != nil {
			if errors.Is(err, store.ErrBadQuery) {
				return nil, rpc.Errf(rpc.CodeInvalidInput, "%v", err)
			}
			return nil, err
		}
		return newEventOuts(events), nil
	})
}

// mapErr turns host errors into RPC errors.
func mapErr(err error) error {
	switch {
	case errors.Is(err, host.ErrChatNotFound), errors.Is(err, host.ErrEventNotFound),
		errors.Is(err, host.ErrMediaNotFound):
		return rpc.Errf(rpc.CodeNotFound, "%v", err)
	case errors.Is(err, host.ErrInvalidInput):
		return rpc.Errf(rpc.CodeInvalidInput, "%v", err)
	default:
		return err
	}
}
