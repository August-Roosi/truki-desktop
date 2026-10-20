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
	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/bridgev2/simplevent"
	"maunium.net/go/mautrix/bridgev2/status"
	"maunium.net/go/mautrix/event"
)

// FlowID is the fake network's only login flow.
const FlowID = "fake"

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
}

// FakeNetwork implements bridgev2.NetworkConnector. Its login processes and
// per-login clients (fakeLogin, fakeClient) implement LoginProcess and
// NetworkAPI.
type FakeNetwork struct {
	Config Config

	mu     sync.Mutex
	br     *bridgev2.Bridge
	starts int
	sent   []FakeSent
}

var (
	_ bridgev2.NetworkConnector      = (*FakeNetwork)(nil)
	_ bridgev2.LoginProcessUserInput = (*fakeLogin)(nil)
	_ bridgev2.NetworkAPI            = (*fakeClient)(nil)
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
	return []bridgev2.LoginFlow{{Name: "Fake", Description: "Log in with any username", ID: FlowID}}
}

func (f *FakeNetwork) CreateLogin(_ context.Context, user *bridgev2.User, flowID string) (bridgev2.LoginProcess, error) {
	if flowID != FlowID {
		return nil, fmt.Errorf("unknown login flow %q", flowID)
	}
	return &fakeLogin{user: user}, nil
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
	return &event.RoomFeatures{ID: "truki.fake"}
}

func (c *fakeClient) HandleMatrixMessage(_ context.Context, msg *bridgev2.MatrixMessage) (*bridgev2.MatrixMessageResponse, error) {
	c.f.mu.Lock()
	c.f.sent = append(c.f.sent, FakeSent{Login: c.login.ID, Portal: msg.Portal.PortalKey, Text: msg.Content.Body})
	n := len(c.f.sent)
	c.f.mu.Unlock()
	return &bridgev2.MatrixMessageResponse{DB: &database.Message{
		ID:        networkid.MessageID(fmt.Sprintf("sent-%d", n)),
		SenderID:  networkid.UserID(c.login.ID),
		Timestamp: time.Now(),
	}}, nil
}
