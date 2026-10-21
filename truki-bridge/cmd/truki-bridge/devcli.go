// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/mdp/qrterminal/v3"
	"maunium.net/go/mautrix/bridgev2"

	"github.com/August-Roosi/truki-desktop/truki-bridge/internal/rpc"
)

// devCLI is `truki-bridge devcli --data <dir>`, a developer REPL: it runs
// this binary as a child in RPC mode on <dir>, with the database key kept in
// <dir>/devcli.key, and prints every event the child pushes. The child's log
// goes to <dir>/devcli.log.
func devCLI(args []string) int {
	flags := flag.NewFlagSet("devcli", flag.ContinueOnError)
	data := flags.String("data", "", "bridge data directory (created when missing)")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *data == "" {
		fmt.Fprintln(os.Stderr, "usage: truki-bridge devcli --data <dir>")
		return 2
	}
	if err := runDevCLI(*data, os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "devcli:", err)
		return 1
	}
	return 0
}

const devCLIHelp = `commands:
  flows <net>              login flows of a network
  login <net> <flow>       log in (prompts for inputs, renders QR codes)
  accounts                 logged-in accounts
  chats                    chats, newest first
  msgs <chatId>            messages of a chat, newest first
  send <chatId> <text>     send a text message
  search <query>           full-text search
  quit                     shut the bridge down and exit`

func runDevCLI(dir string, in io.Reader, out io.Writer) error {
	dir, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	key, err := devCLIKey(filepath.Join(dir, "devcli.key"))
	if err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	logFile, err := os.OpenFile(filepath.Join(dir, "devcli.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer logFile.Close()

	child := exec.Command(exe)
	child.Stderr = logFile
	childIn, err := child.StdinPipe()
	if err != nil {
		return err
	}
	childOut, err := child.StdoutPipe()
	if err != nil {
		return err
	}
	if err := child.Start(); err != nil {
		return err
	}
	c := &devClient{
		w:       childIn,
		out:     &lockedWriter{w: out},
		pending: make(map[int]chan devResponse),
		closed:  make(chan struct{}),
	}
	go c.readLoop(childOut)

	c.printf("child log: %s\n", filepath.Join(dir, "devcli.log"))
	if !c.command("init", map[string]any{"protocolVersion": rpc.ProtocolVersion, "dataDir": dir, "dbKey": key}) {
		_ = childIn.Close()
		_ = child.Wait()
		return errors.New("init failed")
	}
	c.printf("%s\n", devCLIHelp)

	lines := bufio.NewScanner(in)
repl:
	for c.prompt("> ") && lines.Scan() {
		f := strings.Fields(lines.Text())
		if len(f) == 0 {
			continue
		}
		rest := func(i int) string { return strings.Join(f[i:], " ") }
		switch {
		case f[0] == "quit" || f[0] == "exit":
			break repl
		case f[0] == "flows" && len(f) == 2:
			c.command("login.flows", map[string]any{"network": f[1]})
		case f[0] == "login" && len(f) == 3:
			c.login(f[1], f[2], lines)
		case f[0] == "accounts" && len(f) == 1:
			c.command("accounts.list", nil)
		case f[0] == "chats" && len(f) == 1:
			c.command("chats.list", map[string]any{})
		case f[0] == "msgs" && len(f) == 2:
			c.command("messages.list", map[string]any{"chatId": f[1]})
		case f[0] == "send" && len(f) >= 3:
			c.command("messages.send", map[string]any{"chatId": f[1], "text": rest(2)})
		case f[0] == "search" && len(f) >= 2:
			c.command("search", map[string]any{"query": rest(1)})
		default:
			c.printf("%s\n", devCLIHelp)
		}
	}
	c.command("shutdown", nil)
	_ = childIn.Close()
	return child.Wait()
}

// devCLIKey returns the hex database key stored at path, creating it (mode
// 0600) with a random key on first use.
func devCLIKey(path string) (string, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		var b [32]byte
		if _, err := rand.Read(b[:]); err != nil {
			return "", err
		}
		key := hex.EncodeToString(b[:])
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return "", err
		}
		if _, err := f.WriteString(key + "\n"); err != nil {
			_ = f.Close()
			return "", err
		}
		return key, f.Close()
	} else if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(data)), nil
}

type devResponse struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
		Data    struct {
			Code string `json:"code"`
		} `json:"data"`
	} `json:"error"`
}

// devLoginEvent is the params of an event.login.step notification.
type devLoginEvent struct {
	ProcessID string                          `json:"processId"`
	Step      *bridgev2.LoginStep             `json:"step"`
	Seq       int                             `json:"seq"`
	Error     *struct{ Code, Message string } `json:"error"`
}

type devClient struct {
	w   io.Writer
	out *lockedWriter

	mu      sync.Mutex
	nextID  int
	pending map[int]chan devResponse
	steps   chan devLoginEvent // event.login.step during a login, else nil
	closed  chan struct{}      // closed when the child's stdout ends
}

type lockedWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

func (c *devClient) printf(format string, args ...any) {
	fmt.Fprintf(c.out, format, args...)
}

// prompt prints the REPL prompt; it always reports true so it can lead the
// loop condition.
func (c *devClient) prompt(s string) bool {
	c.printf("%s", s)
	return true
}

// readLoop routes responses to their callers and prints every other line
// (the events). Login steps also go to the running login.
func (c *devClient) readLoop(r io.Reader) {
	defer close(c.closed)
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 16<<20)
	for sc.Scan() {
		line := sc.Bytes()
		var msg struct {
			ID     *int            `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			devResponse
		}
		if json.Unmarshal(line, &msg) != nil {
			c.printf("? %s\n", line)
			continue
		}
		if msg.Method == "" && msg.ID != nil {
			c.mu.Lock()
			ch := c.pending[*msg.ID]
			delete(c.pending, *msg.ID)
			c.mu.Unlock()
			if ch != nil {
				ch <- msg.devResponse
			}
			continue
		}
		c.printf("event %s\n", line)
		if msg.Method == "event.login.step" {
			var ev devLoginEvent
			if json.Unmarshal(msg.Params, &ev) == nil {
				c.mu.Lock()
				if c.steps != nil {
					select {
					case c.steps <- ev:
					default:
					}
				}
				c.mu.Unlock()
			}
		}
	}
}

// call sends a request and waits for its response.
func (c *devClient) call(method string, params any) (devResponse, error) {
	c.mu.Lock()
	c.nextID++
	id := c.nextID
	ch := make(chan devResponse, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	req := map[string]any{"jsonrpc": "2.0", "id": id, "method": method}
	if params != nil {
		req["params"] = params
	}
	line, err := json.Marshal(req)
	if err != nil {
		return devResponse{}, err
	}
	if _, err := c.w.Write(append(line, '\n')); err != nil {
		return devResponse{}, err
	}
	select {
	case resp := <-ch:
		return resp, nil
	case <-c.closed:
		return devResponse{}, errors.New("the bridge exited")
	}
}

// command calls method, prints the result or error, and reports success.
func (c *devClient) command(method string, params any) bool {
	resp, err := c.call(method, params)
	if err == nil && resp.Error != nil {
		err = fmt.Errorf("%s (%s)", resp.Error.Message, resp.Error.Data.Code)
	}
	if err != nil {
		c.printf("error: %v\n", err)
		return false
	}
	c.printf("result %s\n", resp.Result)
	return true
}

// login runs a login flow to the end, prompting on lines for inputs.
func (c *devClient) login(network, flow string, lines *bufio.Scanner) {
	steps := make(chan devLoginEvent, 64)
	c.mu.Lock()
	c.steps = steps
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.steps = nil
		c.mu.Unlock()
	}()

	var state struct {
		ProcessID string              `json:"processId"`
		Step      *bridgev2.LoginStep `json:"step"`
		Seq       int                 `json:"seq"`
	}
	resp, ok := c.loginCall("login.start", map[string]any{"network": network, "flowId": flow})
	if !ok || json.Unmarshal(resp, &state) != nil || state.Step == nil {
		return
	}
	for {
		step := state.Step
		if step.Instructions != "" {
			c.printf("%s\n", step.Instructions)
		}
		submit := map[string]any{"processId": state.ProcessID, "stepId": step.StepID}
		switch step.Type {
		case bridgev2.LoginStepTypeComplete:
			c.printf("logged in: %s\n", step.CompleteParams.UserLoginID)
			return
		case bridgev2.LoginStepTypeUserInput:
			values := map[string]string{}
			for _, f := range step.UserInputParams.Fields {
				v, ok := c.ask(lines, f.Name, f.Description)
				if !ok {
					return
				}
				values[f.ID] = v
			}
			submit["input"] = values
		case bridgev2.LoginStepTypeCookies:
			values := map[string]string{}
			for _, f := range step.CookiesParams.Fields {
				v, ok := c.ask(lines, f.ID, "")
				if !ok {
					return
				}
				values[f.ID] = v
			}
			submit["cookies"] = values
		case bridgev2.LoginStepTypeDisplayAndWait:
			c.display(step.DisplayAndWaitParams)
			ev, ok := c.nextStep(steps, state.ProcessID, state.Seq)
			if !ok {
				return
			}
			state.Step, state.Seq = ev.Step, ev.Seq
			continue
		default:
			c.printf("unknown step type %q\n", step.Type)
			return
		}
		resp, ok := c.loginCall("login.submit", submit)
		if !ok || json.Unmarshal(resp, &state) != nil || state.Step == nil {
			return
		}
	}
}

// loginCall is call for the login methods: it prints errors only, since
// the steps are shown as they are handled.
func (c *devClient) loginCall(method string, params any) (json.RawMessage, bool) {
	resp, err := c.call(method, params)
	if err == nil && resp.Error != nil {
		err = fmt.Errorf("%s (%s)", resp.Error.Message, resp.Error.Data.Code)
	}
	if err != nil {
		c.printf("login error: %v\n", err)
		return nil, false
	}
	return resp.Result, true
}

// nextStep waits for the pushed step that follows seq in the process.
func (c *devClient) nextStep(steps <-chan devLoginEvent, processID string, seq int) (devLoginEvent, bool) {
	for {
		select {
		case ev := <-steps:
			if ev.ProcessID != processID {
				continue
			}
			if ev.Error != nil {
				c.printf("login failed: %s (%s)\n", ev.Error.Message, ev.Error.Code)
				return ev, false
			}
			if ev.Seq > seq && ev.Step != nil {
				return ev, true
			}
		case <-c.closed:
			c.printf("login error: the bridge exited\n")
			return devLoginEvent{}, false
		}
	}
}

func (c *devClient) ask(lines *bufio.Scanner, name, description string) (string, bool) {
	if description != "" {
		name += " (" + description + ")"
	}
	c.printf("%s: ", name)
	if !lines.Scan() {
		c.printf("\n")
		return "", false
	}
	return strings.TrimSpace(lines.Text()), true
}

func (c *devClient) display(p *bridgev2.LoginDisplayAndWaitParams) {
	if p == nil {
		return
	}
	if p.Type == bridgev2.LoginDisplayTypeQR {
		var buf bytes.Buffer
		qrterminal.GenerateHalfBlock(p.Data, qrterminal.L, &buf)
		c.printf("%s", buf.Bytes())
		return
	}
	if p.Data != "" {
		c.printf("%s: %s\n", p.Type, p.Data)
	}
}
