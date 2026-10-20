// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package host

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/store"
	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/trukiconnector"
)

var (
	// ErrChatNotFound means the chat ID names no chat.
	ErrChatNotFound = errors.New("chat not found")
	// ErrEventNotFound means an event ID names no event of the chat.
	ErrEventNotFound = errors.New("event not found in chat")
	// ErrInvalidInput means a request is malformed.
	ErrInvalidInput = errors.New("invalid input")
)

// Attachment is a local file to send.
type Attachment struct {
	Path     string
	Name     string
	MimeType string
}

// SendRequest is a message the local user sends to a chat. Each attachment
// is its own event; a non-empty Text is the caption of the first one, or the
// message itself without attachments.
type SendRequest struct {
	ChatID      id.RoomID
	Text        string
	HTML        string
	ReplyTo     id.EventID
	Attachments []Attachment
}

// outgoingConnector is what the host needs from the Truki Matrix connector.
type outgoingConnector interface {
	RecordOutgoing(ctx context.Context, room id.RoomID, evID id.EventID, evtType event.Type, content *event.Content, ts time.Time) (*store.Event, error)
	SetMuted(ctx context.Context, room id.RoomID, until time.Time) (bool, error)
}

// target resolves a chat to its store row, bridge and connector.
func (h *Host) target(ctx context.Context, chatID id.RoomID) (*store.Chat, *bridgev2.Bridge, outgoingConnector, error) {
	chat, err := h.st.GetChat(ctx, chatID)
	if err != nil {
		return nil, nil, nil, err
	}
	if chat == nil {
		return nil, nil, nil, fmt.Errorf("%w: %s", ErrChatNotFound, chatID)
	}
	br, err := h.Bridge(ctx, chat.Network)
	if err != nil {
		return nil, nil, nil, err
	}
	conn, ok := br.Matrix.(outgoingConnector)
	if !ok {
		return nil, nil, nil, fmt.Errorf("%s bridge has no Truki connector", chat.Network)
	}
	return chat, br, conn, nil
}

// requireEvent checks that the event exists in the chat.
func (h *Host) requireEvent(ctx context.Context, chatID id.RoomID, evID id.EventID) error {
	if evID == "" {
		return fmt.Errorf("%w: eventId is required", ErrInvalidInput)
	}
	ev, err := h.st.GetEvent(ctx, evID)
	if err != nil {
		return err
	}
	if ev == nil || ev.RoomID != chatID {
		return fmt.Errorf("%w: %s", ErrEventNotFound, evID)
	}
	return nil
}

// queue records evt as pending and hands it to the bridge. The result
// (sent or failed) arrives through the connector's SendMessageStatus.
func (h *Host) queue(ctx context.Context, br *bridgev2.Bridge, conn outgoingConnector, room id.RoomID, evtType event.Type, content *event.Content) (id.EventID, error) {
	evID := trukiconnector.NewOutgoingEventID()
	now := time.Now()
	if _, err := conn.RecordOutgoing(ctx, room, evID, evtType, content, now); err != nil {
		return "", fmt.Errorf("failed to store outgoing event: %w", err)
	}
	evt := &event.Event{
		Sender:    trukiconnector.LocalUser,
		RoomID:    room,
		ID:        evID,
		Type:      evtType,
		Content:   *content,
		Timestamp: now.UnixMilli(),
	}
	if evtType == event.EventRedaction {
		evt.Redacts = content.Parsed.(*event.RedactionEventContent).Redacts
	}
	bgCtx := br.Log.WithContext(context.WithoutCancel(ctx))
	res := br.QueueMatrixEvent(bgCtx, evt)
	if !res.Success {
		// bridgev2 reports most failures through SendMessageStatus itself;
		// make sure none is left pending.
		cause := res.Error
		if cause == nil {
			cause = errors.New("the bridge did not handle the event")
		}
		if stored, err := h.st.GetEvent(ctx, evID); err == nil && stored != nil && stored.Status == "pending" {
			ms := bridgev2.WrapErrorInStatus(cause).WithStatus(event.MessageStatusFail)
			br.Matrix.SendMessageStatus(bgCtx, &ms, bridgev2.StatusEventInfoFromEvent(evt))
		}
	}
	return evID, nil
}

func textContent(req SendRequest) *event.MessageEventContent {
	content := &event.MessageEventContent{MsgType: event.MsgText, Body: req.Text}
	if req.HTML != "" {
		content.Format = event.FormatHTML
		content.FormattedBody = req.HTML
	}
	return content
}

// attachmentContent uploads the file to the connector's media store and
// builds its m.image or m.file content.
func attachmentContent(ctx context.Context, br *bridgev2.Bridge, room id.RoomID, att Attachment, caption string) (*event.MessageEventContent, error) {
	if att.Path == "" {
		return nil, fmt.Errorf("%w: attachment path is required", ErrInvalidInput)
	}
	data, err := os.ReadFile(att.Path)
	if err != nil {
		return nil, fmt.Errorf("%w: cannot read attachment: %w", ErrInvalidInput, err)
	}
	mime := att.MimeType
	if mime == "" {
		mime = http.DetectContentType(data)
	}
	intent, _, err := br.Matrix.NewUserIntent(ctx, trukiconnector.LocalUser, "")
	if err != nil {
		return nil, err
	}
	uri, file, err := intent.UploadMedia(ctx, room, data, att.Name, mime)
	if err != nil {
		return nil, fmt.Errorf("failed to upload attachment: %w", err)
	}
	content := &event.MessageEventContent{
		MsgType:  event.MsgFile,
		Body:     att.Name,
		FileName: att.Name,
		URL:      uri,
		File:     file,
		Info:     &event.FileInfo{MimeType: mime, Size: len(data)},
	}
	if strings.HasPrefix(mime, "image/") {
		content.MsgType = event.MsgImage
	}
	if caption != "" {
		content.Body = caption
	}
	return content, nil
}

// Send sends a message and returns the ID of its first event. The event is
// stored as pending immediately and updated when the network answers.
func (h *Host) Send(ctx context.Context, req SendRequest) (id.EventID, error) {
	if req.Text == "" && len(req.Attachments) == 0 {
		return "", fmt.Errorf("%w: text or attachments required", ErrInvalidInput)
	}
	for _, att := range req.Attachments {
		if att.Name == "" {
			return "", fmt.Errorf("%w: attachment name is required", ErrInvalidInput)
		}
	}
	if req.ReplyTo != "" {
		if err := h.requireEvent(ctx, req.ChatID, req.ReplyTo); err != nil {
			return "", err
		}
	}
	_, br, conn, err := h.target(ctx, req.ChatID)
	if err != nil {
		return "", err
	}
	var contents []*event.MessageEventContent
	if len(req.Attachments) == 0 {
		contents = append(contents, textContent(req))
	}
	for i, att := range req.Attachments {
		caption := ""
		if i == 0 {
			caption = req.Text
		}
		content, err := attachmentContent(ctx, br, req.ChatID, att, caption)
		if err != nil {
			return "", err
		}
		contents = append(contents, content)
	}
	var first id.EventID
	for i, content := range contents {
		if i == 0 && req.ReplyTo != "" {
			content.RelatesTo = (&event.RelatesTo{}).SetReplyTo(req.ReplyTo)
		}
		evID, err := h.queue(ctx, br, conn, req.ChatID, event.EventMessage, &event.Content{Parsed: content})
		if err != nil {
			return first, err
		}
		if i == 0 {
			first = evID
		}
	}
	return first, nil
}

// React adds the reaction key (an emoji) to a message.
func (h *Host) React(ctx context.Context, chatID id.RoomID, target id.EventID, key string) (id.EventID, error) {
	if key == "" {
		return "", fmt.Errorf("%w: key is required", ErrInvalidInput)
	}
	if err := h.requireEvent(ctx, chatID, target); err != nil {
		return "", err
	}
	_, br, conn, err := h.target(ctx, chatID)
	if err != nil {
		return "", err
	}
	return h.queue(ctx, br, conn, chatID, event.EventReaction, &event.Content{Parsed: &event.ReactionEventContent{
		RelatesTo: event.RelatesTo{Type: event.RelAnnotation, EventID: target, Key: key},
	}})
}

// Redact deletes a message, or removes a reaction when target is one.
func (h *Host) Redact(ctx context.Context, chatID id.RoomID, target id.EventID) error {
	if err := h.requireEvent(ctx, chatID, target); err != nil {
		return err
	}
	_, br, conn, err := h.target(ctx, chatID)
	if err != nil {
		return err
	}
	_, err = h.queue(ctx, br, conn, chatID, event.EventRedaction, &event.Content{Parsed: &event.RedactionEventContent{Redacts: target}})
	return err
}

// MarkRead marks the chat read up to eventID: the unread count drops to the
// messages after it, and the network is sent a read receipt.
func (h *Host) MarkRead(ctx context.Context, chatID id.RoomID, eventID id.EventID) error {
	if err := h.requireEvent(ctx, chatID, eventID); err != nil {
		return err
	}
	_, br, _, err := h.target(ctx, chatID)
	if err != nil {
		return err
	}
	now := time.Now()
	intent, _, err := br.Matrix.NewUserIntent(ctx, trukiconnector.LocalUser, "")
	if err != nil {
		return err
	}
	if err := intent.MarkRead(ctx, chatID, eventID, now); err != nil {
		return fmt.Errorf("failed to update unread count: %w", err)
	}
	receipt := event.ReceiptEventContent{}
	receipt.Set(eventID, event.ReceiptTypeRead, trukiconnector.LocalUser, event.ReadReceipt{Timestamp: now})
	evt := &event.Event{
		RoomID:  chatID,
		Type:    event.EphemeralEventReceipt,
		Content: event.Content{Parsed: &receipt},
	}
	evt.Mautrix.EventSource = event.SourceEphemeral
	br.QueueMatrixEvent(br.Log.WithContext(context.WithoutCancel(ctx)), evt)
	return nil
}

// SetMuted mutes the chat until the given time; the zero time unmutes.
func (h *Host) SetMuted(ctx context.Context, chatID id.RoomID, until time.Time) error {
	_, _, conn, err := h.target(ctx, chatID)
	if err != nil {
		return err
	}
	ok, err := conn.SetMuted(ctx, chatID, until)
	if err == nil && !ok {
		err = fmt.Errorf("%w: %s", ErrChatNotFound, chatID)
	}
	return err
}
