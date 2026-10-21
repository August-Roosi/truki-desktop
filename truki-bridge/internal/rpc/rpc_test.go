// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package rpc

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

type testError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		Code string `json:"code"`
	} `json:"data"`
}

type testResponse struct {
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *testError      `json:"error"`
}

func newTestConn(t *testing.T) (*Conn, *bufio.Reader, io.Writer) {
	t.Helper()
	reqR, reqW := io.Pipe()
	respR, respW := io.Pipe()
	t.Cleanup(func() {
		reqW.Close()
		respR.Close()
	})
	conn := NewConn(reqR, respW, zerolog.Nop())
	return conn, bufio.NewReader(respR), reqW
}

func startServe(t *testing.T, conn *Conn) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = conn.Serve(ctx) }()
}

func writeLine(t *testing.T, w io.Writer, s string) {
	t.Helper()
	if _, err := w.Write([]byte(s + "\n")); err != nil {
		t.Fatalf("write request: %v", err)
	}
}

func readResponse(t *testing.T, r *bufio.Reader) testResponse {
	t.Helper()
	line, err := r.ReadBytes('\n')
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	var resp testResponse
	if err := json.Unmarshal(line, &resp); err != nil {
		t.Fatalf("bad response line %q: %v", line, err)
	}
	return resp
}

func wantErrorCode(t *testing.T, resp testResponse, jsonrpcCode int, trukiCode string) {
	t.Helper()
	if resp.Error == nil {
		t.Fatalf("want error %s, got result %s", trukiCode, resp.Result)
	}
	if resp.Error.Code != jsonrpcCode {
		t.Errorf("error code = %d, want %d", resp.Error.Code, jsonrpcCode)
	}
	if resp.Error.Data.Code != trukiCode {
		t.Errorf("error data.code = %q, want %q", resp.Error.Data.Code, trukiCode)
	}
}

func stubInit(ctx context.Context, p InitParams) (*InitResult, error) {
	return &InitResult{
		ProtocolVersion: ProtocolVersion,
		BridgeVersion:   "test",
		Networks:        []NetworkInfo{{ID: "signal", Name: "Signal"}},
	}, nil
}

func echoHandler(ctx context.Context, params json.RawMessage) (any, error) {
	var p struct {
		Text string `json:"text"`
	}
	if len(params) > 0 {
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, Errf(CodeInvalidInput, "bad params: %v", err)
		}
	}
	return map[string]any{"len": len(p.Text)}, nil
}

func initLine(id, version int) string {
	return fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"method":"init","params":{"protocolVersion":%d,"dataDir":"/tmp","dbKey":"%s"}}`,
		id, version, strings.Repeat("ab", 32))
}

func echoResultLen(t *testing.T, resp testResponse) int {
	t.Helper()
	if resp.Error != nil {
		t.Fatalf("echo failed: %d %s", resp.Error.Code, resp.Error.Message)
	}
	var res struct {
		Len int `json:"len"`
	}
	if err := json.Unmarshal(resp.Result, &res); err != nil {
		t.Fatalf("bad echo result %s: %v", resp.Result, err)
	}
	return res.Len
}

func TestRequestBeforeInit(t *testing.T) {
	conn, out, in := newTestConn(t)
	conn.Handle("echo", echoHandler)
	conn.HandleInit(stubInit)
	startServe(t, conn)

	writeLine(t, in, `{"jsonrpc":"2.0","id":1,"method":"echo"}`)
	resp := readResponse(t, out)
	wantErrorCode(t, resp, -32000, "NOT_INITIALIZED")
}

func TestUnknownMethod(t *testing.T) {
	conn, out, in := newTestConn(t)
	conn.Handle("echo", echoHandler)
	conn.HandleInit(stubInit)
	startServe(t, conn)

	writeLine(t, in, initLine(1, ProtocolVersion))
	if resp := readResponse(t, out); resp.Error != nil {
		t.Fatalf("init failed: %d %s", resp.Error.Code, resp.Error.Message)
	}

	writeLine(t, in, `{"jsonrpc":"2.0","id":2,"method":"nope"}`)
	resp := readResponse(t, out)
	wantErrorCode(t, resp, -32601, "INVALID_INPUT")
}

func TestMalformedLine(t *testing.T) {
	conn, out, in := newTestConn(t)
	conn.Handle("echo", echoHandler)
	conn.HandleInit(stubInit)
	startServe(t, conn)

	writeLine(t, in, initLine(1, ProtocolVersion))
	readResponse(t, out)

	writeLine(t, in, `{nope`)
	resp := readResponse(t, out)
	wantErrorCode(t, resp, -32700, "INVALID_INPUT")
	if got := strings.TrimSpace(string(resp.ID)); got != "null" {
		t.Errorf("parse error id = %q, want null", got)
	}

	writeLine(t, in, `{"jsonrpc":"2.0","id":7,"method":"echo","params":{"text":"x"}}`)
	resp = readResponse(t, out)
	if n := echoResultLen(t, resp); n != 1 {
		t.Fatalf("echo len = %d, want 1", n)
	}
}

func TestLargeLine(t *testing.T) {
	conn, out, in := newTestConn(t)
	conn.Handle("echo", echoHandler)
	conn.HandleInit(stubInit)
	startServe(t, conn)

	writeLine(t, in, initLine(1, ProtocolVersion))
	readResponse(t, out)

	// A 1 MiB params value fits under the 16 MiB line cap.
	writeLine(t, in, `{"jsonrpc":"2.0","id":2,"method":"echo","params":{"text":"`+
		strings.Repeat("a", 1<<20)+`"}}`)
	if n := echoResultLen(t, readResponse(t, out)); n != 1<<20 {
		t.Fatalf("echo len = %d, want %d", n, 1<<20)
	}

	// A 17 MiB line is rejected without breaking the stream.
	writeLine(t, in, `{"jsonrpc":"2.0","id":3,"method":"echo","params":{"text":"`+
		strings.Repeat("b", 17<<20)+`"}}`)
	wantErrorCode(t, readResponse(t, out), -32602, "INVALID_INPUT")

	writeLine(t, in, `{"jsonrpc":"2.0","id":4,"method":"echo","params":{"text":"ok"}}`)
	if n := echoResultLen(t, readResponse(t, out)); n != 2 {
		t.Fatalf("echo len = %d, want 2", n)
	}
}

func TestNotifyConcurrent(t *testing.T) {
	conn, out, _ := newTestConn(t)

	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			conn.Notify("progress", map[string]any{"n": i})
		}(i)
	}
	// io.Pipe is unbuffered: reads must overlap the writers.
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	for i := 0; i < 100; i++ {
		line, err := out.ReadBytes('\n')
		if err != nil {
			t.Fatalf("read notification %d: %v", i, err)
		}
		if !json.Valid(line) {
			t.Fatalf("notification %d is not valid JSON: %q", i, line)
		}
	}
	<-done
}

func TestInitVersionMismatch(t *testing.T) {
	conn, out, in := newTestConn(t)
	called := false
	conn.HandleInit(func(ctx context.Context, p InitParams) (*InitResult, error) {
		called = true
		return stubInit(ctx, p)
	})
	startServe(t, conn)

	writeLine(t, in, initLine(1, ProtocolVersion+1))
	wantErrorCode(t, readResponse(t, out), -32602, "INVALID_INPUT")
	if called {
		t.Error("init handler was called on a version mismatch")
	}

	// A corrected init is accepted afterwards.
	writeLine(t, in, initLine(2, ProtocolVersion))
	if resp := readResponse(t, out); resp.Error != nil {
		t.Fatalf("retry init failed: %d %s", resp.Error.Code, resp.Error.Message)
	}
	if !called {
		t.Error("init handler was never called")
	}
}

func TestInitFlow(t *testing.T) {
	conn, out, in := newTestConn(t)
	conn.Handle("echo", echoHandler)
	conn.HandleInit(stubInit)
	startServe(t, conn)

	writeLine(t, in, initLine(1, ProtocolVersion))
	resp := readResponse(t, out)
	if resp.Error != nil {
		t.Fatalf("init failed: %d %s", resp.Error.Code, resp.Error.Message)
	}
	var res InitResult
	if err := json.Unmarshal(resp.Result, &res); err != nil {
		t.Fatalf("bad init result %s: %v", resp.Result, err)
	}
	if res.ProtocolVersion != ProtocolVersion || res.BridgeVersion != "test" ||
		len(res.Networks) != 1 || res.Networks[0].ID != "signal" || res.Networks[0].Name != "Signal" {
		t.Fatalf("init result = %+v", res)
	}

	// A second init after a successful one is rejected.
	writeLine(t, in, initLine(2, ProtocolVersion))
	wantErrorCode(t, readResponse(t, out), -32602, "INVALID_INPUT")

	// Methods work once the handshake is done.
	writeLine(t, in, `{"jsonrpc":"2.0","id":3,"method":"echo","params":{"text":"hi"}}`)
	if n := echoResultLen(t, readResponse(t, out)); n != 2 {
		t.Fatalf("echo len = %d, want 2", n)
	}
}

// TestConcurrentDispatch checks that a slow handler does not block the
// rest of the stream: the fast response must arrive while the slow
// handler is still blocked, and the slow response follows once released.
func TestConcurrentDispatch(t *testing.T) {
	conn, out, in := newTestConn(t)
	release := make(chan struct{})
	conn.Handle("slow", func(ctx context.Context, params json.RawMessage) (any, error) {
		<-release
		return "slow", nil
	})
	conn.Handle("fast", func(ctx context.Context, params json.RawMessage) (any, error) {
		return "fast", nil
	})
	conn.HandleInit(stubInit)
	startServe(t, conn)

	writeLine(t, in, initLine(1, ProtocolVersion))
	readResponse(t, out)

	writeLine(t, in, `{"jsonrpc":"2.0","id":1,"method":"slow"}`)
	writeLine(t, in, `{"jsonrpc":"2.0","id":2,"method":"fast"}`)

	responses := make(chan testResponse, 2)
	go func() {
		for {
			line, err := out.ReadBytes('\n')
			if err != nil {
				close(responses)
				return
			}
			var resp testResponse
			if json.Unmarshal(line, &resp) != nil {
				continue
			}
			responses <- resp
		}
	}()

	select {
	case resp, ok := <-responses:
		if !ok {
			t.Fatal("output closed before a response arrived")
		}
		if got := strings.TrimSpace(string(resp.ID)); got != "2" {
			t.Fatalf("response id = %q, want 2 while the slow handler is blocked", got)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the fast request was not answered while the slow handler was blocked")
	}

	close(release)

	select {
	case resp, ok := <-responses:
		if !ok {
			t.Fatal("output closed before the slow response arrived")
		}
		if got := strings.TrimSpace(string(resp.ID)); got != "1" {
			t.Fatalf("response id = %q, want 1", got)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the slow request was never answered after it was released")
	}
}

// TestHandlerPanic checks that a panicking handler is answered with
// INTERNAL and that the bridge keeps serving afterwards.
func TestHandlerPanic(t *testing.T) {
	conn, out, in := newTestConn(t)
	conn.Handle("boom", func(ctx context.Context, params json.RawMessage) (any, error) {
		panic("handler blew up")
	})
	conn.Handle("echo", echoHandler)
	conn.HandleInit(stubInit)
	startServe(t, conn)

	writeLine(t, in, initLine(1, ProtocolVersion))
	readResponse(t, out)

	writeLine(t, in, `{"jsonrpc":"2.0","id":1,"method":"boom"}`)
	resp := readResponse(t, out)
	wantErrorCode(t, resp, -32000, "INTERNAL")
	if resp.Error.Message != "internal error" {
		t.Errorf("panic error message = %q, want %q", resp.Error.Message, "internal error")
	}

	writeLine(t, in, `{"jsonrpc":"2.0","id":2,"method":"echo","params":{"text":"still alive"}}`)
	if n := echoResultLen(t, readResponse(t, out)); n != len("still alive") {
		t.Fatalf("echo len = %d, want %d", n, len("still alive"))
	}
}

func TestClientNotification(t *testing.T) {
	conn, out, in := newTestConn(t)
	conn.Handle("echo", echoHandler)
	conn.HandleInit(stubInit)
	startServe(t, conn)

	writeLine(t, in, initLine(1, ProtocolVersion))
	readResponse(t, out)

	// A notification (no id) is dispatched without a response.
	writeLine(t, in, `{"jsonrpc":"2.0","method":"echo","params":{"text":"n"}}`)
	writeLine(t, in, `{"jsonrpc":"2.0","id":2,"method":"echo","params":{"text":"r"}}`)
	resp := readResponse(t, out)
	if got := strings.TrimSpace(string(resp.ID)); got != "2" {
		t.Fatalf("response id = %q, want 2 (a notification must not be answered)", got)
	}
	if n := echoResultLen(t, resp); n != 1 {
		t.Fatalf("echo len = %d, want 1", n)
	}
}

// lockedBuffer is a bytes.Buffer safe for the concurrent handler goroutines.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// A non-INTERNAL handler error is logged with its method and code only: its
// message may be the network's login error text. INTERNAL keeps the message.
func TestHandlerErrorLogging(t *testing.T) {
	reqR, reqW := io.Pipe()
	respR, respW := io.Pipe()
	t.Cleanup(func() {
		reqW.Close()
		respR.Close()
	})
	var logs lockedBuffer
	conn := NewConn(reqR, respW, zerolog.New(&logs))
	out := bufio.NewReader(respR)
	conn.Handle("login", func(context.Context, json.RawMessage) (any, error) {
		return nil, &Error{Code: "LOGIN_FAILED", Message: "wrong password hunter2"}
	})
	conn.Handle("broken", func(context.Context, json.RawMessage) (any, error) {
		return nil, fmt.Errorf("disk on fire")
	})
	conn.HandleInit(stubInit)
	startServe(t, conn)

	writeLine(t, reqW, initLine(1, ProtocolVersion))
	readResponse(t, out)

	writeLine(t, reqW, `{"jsonrpc":"2.0","id":2,"method":"login"}`)
	resp := readResponse(t, out)
	wantErrorCode(t, resp, -32000, "LOGIN_FAILED")
	if resp.Error.Message != "wrong password hunter2" {
		t.Errorf("response message = %q; the caller still gets it", resp.Error.Message)
	}
	writeLine(t, reqW, `{"jsonrpc":"2.0","id":3,"method":"broken"}`)
	wantErrorCode(t, readResponse(t, out), -32000, "INTERNAL")

	// Each handler logs before its response is written.
	got := logs.String()
	if strings.Contains(got, "hunter2") || strings.Contains(got, "wrong password") {
		t.Errorf("non-INTERNAL error message was logged:\n%s", got)
	}
	if !strings.Contains(got, `"method":"login"`) || !strings.Contains(got, `"code":"LOGIN_FAILED"`) {
		t.Errorf("non-INTERNAL error not logged with method and code:\n%s", got)
	}
	if !strings.Contains(got, "disk on fire") {
		t.Errorf("INTERNAL error logged without its message:\n%s", got)
	}
}
