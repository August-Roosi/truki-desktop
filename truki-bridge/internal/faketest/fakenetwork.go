// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

// Package faketest provides an in-memory bridgev2 network connector for
// end-to-end tests of the bridge host. It has one login flow ("fake": enter a
// username, done), delivers messages on demand and records what the bridge
// sends to it.
package faketest

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"go.mau.fi/util/configupgrade"
	"maunium.net/go/mautrix"
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/simplevent"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/event"
)

// FlowID is the fake network's only login flow.
const FlowID = "fake"

// QRFlowID is a display_and_wait flow: it shows qr-0, refreshes to qr-1 and
// qr-2, then completes with a login named QRUser.
const QRFlowID = "fake-qr"

// QRTimeoutFlowID is like QRFlowID but the first wait fails with a timeout.
const QRTimeoutFlowID = "fake-qr-timeout"

// QRUser is the remote name of the login the QR flow creates.
const QRUser = "qr-user"

// FriendID is the remote user every delivered message comes from.
const FriendID networkid.UserID = "friend"

// exampleConfig is the network config example the host loads.
const exampleConfig = "greeting: hello\n"

// Config is the fake network's config, filled from exampleConfig.
type Config struct {
	Greeting string `yaml:"greeting"`
}

// FakeSent is one message the bridge sent to the fake network.
type FakeSent struct {
	Login  networkid.UserLoginID
	Portal networkid.PortalKey
	Text   string
	// ReplyTo is the remote ID of the message replied to, if any.
	ReplyTo networkid.MessageID
	// File, FileName and MimeType describe an attachment; File is nil for
	// a text message.
	File     []byte
	FileName string
	MimeType string
}

// FakeReaction is one reaction the bridge added to or removed from a
// message of the fake network.
type FakeReaction struct {
	Login   networkid.UserLoginID
	Message networkid.MessageID
	Emoji   string
	Removed bool
}

// FakeReceipt is one read receipt the bridge sent to the fake network.
type FakeReceipt struct {
	Login  networkid.UserLoginID
	Portal networkid.PortalKey
	// Message is the remote ID of the message read up to ("" when the
	// receipt names no bridged message).
	Message networkid.MessageID
}

// FakeRemoval is one message deletion the bridge sent to the fake network.
type FakeRemoval struct {
	Login   networkid.UserLoginID
	Message networkid.MessageID
}

// ErrRateLimited is the error a send fails with after FailNextSend: a
// retriable status whose reason is the Matrix rate limit error.
var ErrRateLimited = bridgev2.WrapErrorInStatus(errors.New("too many requests")).
	WithErrorReason(event.MessageStatusReason(mautrix.MLimitExceeded.ErrCode))

// FakeNetwork implements bridgev2.NetworkConnector. Its login processes and
// per-login clients (fakeLogin, fakeClient) implement LoginProcess and
// NetworkAPI.
type FakeNetwork struct {
	Config Config

	mu           sync.Mutex
	br           *bridgev2.Bridge
	starts       int
	loginCancels int

	sent      []FakeSent
	attempts  int
	failNext  error
	reactions []FakeReaction
	removals  []FakeRemoval
	receipts  []FakeReceipt
}

var (
	_ bridgev2.NetworkConnector      = (*FakeNetwork)(nil)
	_ bridgev2.LoginProcessUserInput = (*fakeLogin)(nil)
	_ bridgev2.NetworkAPI            = (*fakeClient)(nil)

	_ bridgev2.ReactionHandlingNetworkAPI    = (*fakeClient)(nil)
	_ bridgev2.RedactionHandlingNetworkAPI   = (*fakeClient)(nil)
	_ bridgev2.ReadReceiptHandlingNetworkAPI = (*fakeClient)(nil)
)

// NewFakeNetwork returns a fake network connector.
func NewFakeNetwork() *FakeNetwork {
	return &FakeNetwork{}
}

func (f *FakeNetwork) Init(br *bridgev2.Bridge) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.br = br
}

func (f *FakeNetwork) Start(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.starts++
	return nil
}

// StartCount reports how many times Start was called.
func (f *FakeNetwork) StartCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.starts
}

func (f *FakeNetwork) bridge() *bridgev2.Bridge {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.br
}

func (f *FakeNetwork) GetName() bridgev2.BridgeName {
	return bridgev2.BridgeName{
		DisplayName:      "Fake",
		NetworkID:        "fake",
		BeeperBridgeType: "github.com/August-Roosi/truki-desktop/truki-bridge/internal/faketest",
	}
}

func (f *FakeNetwork) GetDBMetaTypes() database.MetaTypes { return database.MetaTypes{} }

func (f *FakeNetwork) GetCapabilities() *bridgev2.NetworkGeneralCapabilities {
	return &bridgev2.NetworkGeneralCapabilities{}
}

func (f *FakeNetwork) GetConfig() (string, any, configupgrade.Upgrader) {
	return exampleConfig, &f.Config, nil
}

func (f *FakeNetwork) GetBridgeInfoVersion() (int, int) { return 1, 1 }

func (f *FakeNetwork) LoadUserLogin(_ context.Context, login *bridgev2.UserLogin) error {
	login.Client = &fakeClient{f: f, login: login}
	return nil
}

func (f *FakeNetwork) GetLoginFlows() []bridgev2.LoginFlow {
	return []bridgev2.LoginFlow{
		{Name: "Fake", Description: "Log in with any username", ID: FlowID},
		{Name: "Fake QR", Description: "Log in by scanning a code", ID: QRFlowID},
		{Name: "Fake QR (times out)", Description: "A code nobody scans", ID: QRTimeoutFlowID},
	}
}

func (f *FakeNetwork) CreateLogin(_ context.Context, user *bridgev2.User, flowID string) (bridgev2.LoginProcess, error) {
	switch flowID {
	case FlowID:
		return &fakeLogin{user: user}, nil
	case QRFlowID, QRTimeoutFlowID:
		return &fakeQRLogin{f: f, user: user, timeout: flowID == QRTimeoutFlowID}, nil
	}
	return nil, fmt.Errorf("unknown login flow %q", flowID)
}

// LoginCancels returns how many display_and_wait login processes were
// cancelled.
func (f *FakeNetwork) LoginCancels() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.loginCancels
}

// Deliver makes the network report an incoming text message from FriendID
// in chat, as received by login. It panics if login is not loaded.
func (f *FakeNetwork) Deliver(login networkid.UserLoginID, chat networkid.PortalID, msgID networkid.MessageID, text string) {
	ul := f.bridge().GetCachedUserLoginByID(login)
	if ul == nil {
		panic(fmt.Sprintf("faketest: login %q is not loaded", login))
	}
	ul.QueueRemoteEvent(&simplevent.Message[string]{
		EventMeta: simplevent.EventMeta{
			Type:         bridgev2.RemoteEventMessage,
			PortalKey:    networkid.PortalKey{ID: chat},
			Sender:       bridgev2.EventSender{Sender: FriendID},
			CreatePortal: true,
			Timestamp:    time.Now(),
		},
		ID:   msgID,
		Data: text,
		ConvertMessageFunc: func(_ context.Context, _ *bridgev2.Portal, _ bridgev2.MatrixAPI, text string) (*bridgev2.ConvertedMessage, error) {
			return &bridgev2.ConvertedMessage{Parts: []*bridgev2.ConvertedMessagePart{{
				Type:    event.EventMessage,
				Content: &event.MessageEventContent{MsgType: event.MsgText, Body: text},
			}}}, nil
		},
	})
}

// Sent returns the messages the bridge sent to the network, oldest first.
func (f *FakeNetwork) Sent() []FakeSent {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]FakeSent(nil), f.sent...)
}

// SendAttempts returns how many times the bridge handed the network a
// message, whether or not it succeeded.
func (f *FakeNetwork) SendAttempts() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.attempts
}

// FailNextSend makes the next message send fail with err, once.
func (f *FakeNetwork) FailNextSend(err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failNext = err
}

// Reactions returns the reactions added and removed, oldest first.
func (f *FakeNetwork) Reactions() []FakeReaction {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]FakeReaction(nil), f.reactions...)
}

// Removals returns the message deletions, oldest first.
func (f *FakeNetwork) Removals() []FakeRemoval {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]FakeRemoval(nil), f.removals...)
}

// Receipts returns the read receipts, oldest first.
func (f *FakeNetwork) Receipts() []FakeReceipt {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]FakeReceipt(nil), f.receipts...)
}

// fakeLogin is the "fake" flow: one username field, then complete.
type fakeLogin struct {
	user *bridgev2.User
}

func (l *fakeLogin) Start(context.Context) (*bridgev2.LoginStep, error) {
	return &bridgev2.LoginStep{
		Type:         bridgev2.LoginStepTypeUserInput,
		StepID:       "truki.fake.username",
		Instructions: "Enter any username",
		UserInputParams: &bridgev2.LoginUserInputParams{Fields: []bridgev2.LoginInputDataField{{
			Type: bridgev2.LoginInputFieldTypeUsername, ID: "username", Name: "Username",
		}}},
	}, nil
}

func (l *fakeLogin) SubmitUserInput(ctx context.Context, input map[string]string) (*bridgev2.LoginStep, error) {
	username := input["username"]
	if username == "" {
		return nil, errors.New("username is required")
	}
	ul, err := l.user.NewLogin(ctx, &database.UserLogin{
		ID:         networkid.UserLoginID(username),
		RemoteName: username,
	}, nil)
	if err != nil {
		return nil, err
	}
	ul.Client.Connect(ul.Log.WithContext(context.Background()))
	return &bridgev2.LoginStep{
		Type:           bridgev2.LoginStepTypeComplete,
		StepID:         "truki.fake.complete",
		Instructions:   "Logged in as " + username,
		CompleteParams: &bridgev2.LoginCompleteParams{UserLoginID: ul.ID, UserLogin: ul},
	}, nil
}

func (l *fakeLogin) Cancel() {}

// fakeQRLogin is the display_and_wait flow. Each Wait returns the next code
// at once; after qr-2 the login completes. In the timeout variant the first
// Wait fails instead.
type fakeQRLogin struct {
	user    *bridgev2.User
	timeout bool
	n       int
	f       *FakeNetwork
}

var _ bridgev2.LoginProcessDisplayAndWait = (*fakeQRLogin)(nil)

func (l *fakeQRLogin) qrStep() *bridgev2.LoginStep {
	return &bridgev2.LoginStep{
		Type:         bridgev2.LoginStepTypeDisplayAndWait,
		StepID:       "truki.fake.qr",
		Instructions: "Scan the code",
		DisplayAndWaitParams: &bridgev2.LoginDisplayAndWaitParams{
			Type: bridgev2.LoginDisplayTypeQR, Data: fmt.Sprintf("qr-%d", l.n),
		},
	}
}

func (l *fakeQRLogin) Start(context.Context) (*bridgev2.LoginStep, error) {
	return l.qrStep(), nil
}

func (l *fakeQRLogin) Wait(ctx context.Context) (*bridgev2.LoginStep, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if l.timeout {
		return nil, bridgev2.RespError{ErrCode: "FAKE_LOGIN_TIMEOUT", Err: "The code was not scanned in time"}
	}
	l.n++
	if l.n <= 2 {
		return l.qrStep(), nil
	}
	ul, err := l.user.NewLogin(ctx, &database.UserLogin{ID: networkid.UserLoginID(QRUser), RemoteName: QRUser}, nil)
	if err != nil {
		return nil, err
	}
	ul.Client.Connect(ul.Log.WithContext(context.Background()))
	return &bridgev2.LoginStep{
		Type:           bridgev2.LoginStepTypeComplete,
		StepID:         "truki.fake.complete",
		Instructions:   "Logged in as " + QRUser,
		CompleteParams: &bridgev2.LoginCompleteParams{UserLoginID: ul.ID, UserLogin: ul},
	}, nil
}

func (l *fakeQRLogin) Cancel() {
	l.f.mu.Lock()
	defer l.f.mu.Unlock()
	l.f.loginCancels++
}

// fakeClient is the NetworkAPI of one login. The login's remote user ID
// equals its login ID.
type fakeClient struct {
	f     *FakeNetwork
	login *bridgev2.UserLogin
}

func (c *fakeClient) Connect(context.Context) {
	c.login.BridgeState.Send(status.BridgeState{StateEvent: status.StateConnected})
}

func (c *fakeClient) Disconnect()                  {}
func (c *fakeClient) IsLoggedIn() bool             { return true }
func (c *fakeClient) LogoutRemote(context.Context) {}

func (c *fakeClient) IsThisUser(_ context.Context, userID networkid.UserID) bool {
	return string(userID) == string(c.login.ID)
}

func (c *fakeClient) GetChatInfo(_ context.Context, portal *bridgev2.Portal) (*bridgev2.ChatInfo, error) {
	name := "Chat " + string(portal.ID)
	return &bridgev2.ChatInfo{
		Name: &name,
		Members: &bridgev2.ChatMemberList{
			IsFull: true,
			MemberMap: bridgev2.ChatMemberMap{
				networkid.UserID(c.login.ID): {
					EventSender: bridgev2.EventSender{IsFromMe: true, Sender: networkid.UserID(c.login.ID)},
					Membership:  event.MembershipJoin,
				},
				FriendID: {
					EventSender: bridgev2.EventSender{Sender: FriendID},
					Membership:  event.MembershipJoin,
				},
			},
		},
	}, nil
}

func (c *fakeClient) GetUserInfo(_ context.Context, ghost *bridgev2.Ghost) (*bridgev2.UserInfo, error) {
	name := "Fake " + string(ghost.ID)
	return &bridgev2.UserInfo{Name: &name}, nil
}

func (c *fakeClient) GetCapabilities(context.Context, *bridgev2.Portal) *event.RoomFeatures {
	return &event.RoomFeatures{
		ID:       "truki.fake",
		Reply:    event.CapLevelFullySupported,
		Reaction: event.CapLevelFullySupported,
		Delete:   event.CapLevelFullySupported,
		File: event.FileFeatureMap{
			event.MsgImage: {MimeTypes: map[string]event.CapabilitySupportLevel{"*/*": event.CapLevelFullySupported}},
			event.MsgFile:  {MimeTypes: map[string]event.CapabilitySupportLevel{"*/*": event.CapLevelFullySupported}},
		},
		ReadReceipts: true,
	}
}

func (c *fakeClient) HandleMatrixMessage(ctx context.Context, msg *bridgev2.MatrixMessage) (*bridgev2.MatrixMessageResponse, error) {
	c.f.mu.Lock()
	c.f.attempts++
	if err := c.f.failNext; err != nil {
		c.f.failNext = nil
		c.f.mu.Unlock()
		return nil, err
	}
	c.f.mu.Unlock()
	sent := FakeSent{Login: c.login.ID, Portal: msg.Portal.PortalKey, Text: msg.Content.Body}
	if msg.ReplyTo != nil {
		sent.ReplyTo = msg.ReplyTo.ID
	}
	switch msg.Content.MsgType {
	case event.MsgImage, event.MsgFile:
		data, err := c.login.Bridge.Bot.DownloadMedia(ctx, msg.Content.URL, msg.Content.File)
		if err != nil {
			return nil, fmt.Errorf("failed to download attachment: %w", err)
		}
		sent.File, sent.FileName = data, msg.Content.GetFileName()
		if msg.Content.Info != nil {
			sent.MimeType = msg.Content.Info.MimeType
		}
	}
	c.f.mu.Lock()
	c.f.sent = append(c.f.sent, sent)
	n := len(c.f.sent)
	c.f.mu.Unlock()
	return &bridgev2.MatrixMessageResponse{DB: &database.Message{
		ID:        networkid.MessageID(fmt.Sprintf("sent-%d", n)),
		SenderID:  networkid.UserID(c.login.ID),
		Timestamp: time.Now(),
	}}, nil
}

func (c *fakeClient) PreHandleMatrixReaction(_ context.Context, msg *bridgev2.MatrixReaction) (bridgev2.MatrixReactionPreResponse, error) {
	return bridgev2.MatrixReactionPreResponse{
		SenderID: networkid.UserID(c.login.ID),
		EmojiID:  networkid.EmojiID(msg.Content.RelatesTo.Key),
		Emoji:    msg.Content.RelatesTo.Key,
	}, nil
}

func (c *fakeClient) HandleMatrixReaction(_ context.Context, msg *bridgev2.MatrixReaction) (*database.Reaction, error) {
	c.f.mu.Lock()
	defer c.f.mu.Unlock()
	c.f.reactions = append(c.f.reactions, FakeReaction{
		Login: c.login.ID, Message: msg.TargetMessage.ID, Emoji: msg.PreHandleResp.Emoji,
	})
	return nil, nil
}

func (c *fakeClient) HandleMatrixReactionRemove(_ context.Context, msg *bridgev2.MatrixReactionRemove) error {
	c.f.mu.Lock()
	defer c.f.mu.Unlock()
	c.f.reactions = append(c.f.reactions, FakeReaction{
		Login: c.login.ID, Message: msg.TargetReaction.MessageID, Emoji: string(msg.TargetReaction.EmojiID), Removed: true,
	})
	return nil
}

func (c *fakeClient) HandleMatrixMessageRemove(_ context.Context, msg *bridgev2.MatrixMessageRemove) error {
	c.f.mu.Lock()
	defer c.f.mu.Unlock()
	c.f.removals = append(c.f.removals, FakeRemoval{Login: c.login.ID, Message: msg.TargetMessage.ID})
	return nil
}

func (c *fakeClient) HandleMatrixReadReceipt(_ context.Context, msg *bridgev2.MatrixReadReceipt) error {
	r := FakeReceipt{Login: c.login.ID, Portal: msg.Portal.PortalKey}
	if msg.ExactMessage != nil {
		r.Message = msg.ExactMessage.ID
	}
	c.f.mu.Lock()
	defer c.f.mu.Unlock()
	c.f.receipts = append(c.f.receipts, r)
	return nil
}
