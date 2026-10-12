// Package main is the runner inside the natsumi workspace container (ADR 0011, ADR 0019).
//
// It listens on a Unix socket that natsumi reaches through a shared volume, runs each command with `bash -c` in the
// work directory, and answers with the exit code and the output so far. The confinement is the container's: no
// network, no secrets, and only the four writable places ADR 0019 lists.
//
// A command is never stopped. The response limit is the line at which the runner answers, not the line at which the
// command dies (ADR 0019): past it the answer says the command is still running, the process is left alone, and its
// output goes on being read and thrown away so the pipe cannot fill and block it.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// MaxRequestBytes bounds one request line. 8000 characters of Japanese is 24 KiB in UTF-8, and up to 48 KiB once
// JSON escaping has had its worst; 64 KiB holds that with room for the rest of the line (ADR 0019).
const MaxRequestBytes = 64 << 10

// After the shell exits, how long the runner waits for what is still in the pipes before it answers.
const flushDelay = 200 * time.Millisecond

// Bytes read from a command that has already been answered for, and thrown away, per read.
const drainBuffer = 32 << 10

// Limits are fixed when the runner starts; a request cannot change them. Only the time zone may come with a request,
// because it belongs to natsumi's configuration rather than to the confinement.
type Limits struct {
	Shell     string
	Path      string
	Dir       string
	Home      string
	Lang      string
	TimeZone  string
	Response  time.Duration
	MaxOutput int
}

// Result is the answer to a command. ExitCode and Signal are empty while StillRunning is true: the command has not
// ended yet, so it has neither.
type Result struct {
	ExitCode        *int   `json:"exitCode"`
	Signal          string `json:"signal,omitempty"`
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
	StdoutTruncated bool   `json:"stdoutTruncated"`
	StderrTruncated bool   `json:"stderrTruncated"`
	// The response limit was reached and the command was left running.
	StillRunning bool `json:"stillRunning"`
	// A declared tool's timeout was reached and its process group was killed (ADR 0075). Never set for a command.
	TimedOut bool `json:"timedOut"`
	// The response limit in milliseconds, so the answer can say how long it waited; a tool's timeout for a tool.
	ResponseLimitMs int64 `json:"responseLimitMs"`
	// Commands this runner started that are still alive, this one included while it is.
	Running int `json:"running"`
}

type refusal struct {
	Error string `json:"error"`
}

// A time zone name, kept to what tzdata can hold so nothing odd reaches the environment of a command.
var timeZoneName = regexp.MustCompile(`^[A-Za-z0-9_+\-/]{1,64}$`)

// capped keeps the first max bytes written and remembers whether more came. Once frozen it keeps nothing: the
// command has been answered for, and what it writes from then on is read only to keep its pipe moving.
type capped struct {
	mu        sync.Mutex
	buffer    bytes.Buffer
	max       int
	truncated bool
	frozen    bool
}

func (c *capped) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.frozen {
		return len(p), nil
	}
	room := c.max - c.buffer.Len()
	switch {
	case room >= len(p):
		c.buffer.Write(p)
	case room > 0:
		c.buffer.Write(p[:room])
		c.truncated = true
	case len(p) > 0:
		c.truncated = true
	}
	return len(p), nil
}

// take freezes the buffer and returns what it holds, as valid UTF-8.
func (c *capped) take() (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.frozen = true
	return strings.ToValidUTF8(c.buffer.String(), "�"), c.truncated
}

// Server answers one JSON request line per connection and waits on one command at a time. Commands it has already
// answered for go on running outside the lock.
type Server struct {
	Limits Limits
	mu     sync.Mutex
	live   atomic.Int64
}

// A command still counted as running. Released once its shell has exited and its output has reached its end, so a
// shell that left something behind keeps counting for as long as that something holds the output open.
type liveCommand struct {
	server *Server
	once   sync.Once
}

func (l *liveCommand) release() {
	l.once.Do(func() { l.server.live.Add(-1) })
}

// Run runs one command in its own process group and answers when it ends or when the response limit is reached,
// whichever comes first. Nothing is killed either way.
func (s *Server) Run(command string, timeZone string) Result {
	limits := s.limitsFor(timeZone)
	result := Result{ResponseLimitMs: limits.Response.Milliseconds()}

	outRead, outWrite, err := os.Pipe()
	if err != nil {
		return s.unstarted(result, "the runner could not open a pipe\n")
	}
	errRead, errWrite, err := os.Pipe()
	if err != nil {
		closeAll(outRead, outWrite)
		return s.unstarted(result, "the runner could not open a pipe\n")
	}

	cmd := exec.Command(limits.Shell, "-c", command)
	cmd.Dir = limits.Dir
	// Nothing from the runner's own environment reaches the command; os/exec adds PWD from Dir (ADR 0019).
	cmd.Env = environment(limits)
	cmd.Stdin = nil
	cmd.Stdout = outWrite
	cmd.Stderr = errWrite
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		closeAll(outRead, outWrite, errRead, errWrite)
		return s.unstarted(result, "the shell could not be started\n")
	}
	// The runner holds no write end of its own, so the pipes end when the command and everything it left have let go.
	closeAll(outWrite, errWrite)

	stdout := &capped{max: limits.MaxOutput}
	stderr := &capped{max: limits.MaxOutput}
	var drains sync.WaitGroup
	drains.Add(2)
	go drain(outRead, stdout, &drains)
	go drain(errRead, stderr, &drains)

	s.live.Add(1)
	entry := &liveCommand{server: s}
	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()
	ended := make(chan struct{})
	go func() { drains.Wait(); close(ended) }()
	// Whatever happens above, the command stops counting once it is over and its output has run out.
	go func() {
		<-exited
		<-ended
		closeAll(outRead, errRead)
		entry.release()
	}()

	timer := time.NewTimer(limits.Response)
	defer timer.Stop()
	finished := false
	select {
	case <-exited:
		finished = true
	case <-timer.C:
	}
	if finished {
		// What the shell wrote just before it exited is still in the pipe; anything it left behind holds them open.
		select {
		case <-ended:
			entry.release()
		case <-time.After(flushDelay):
		}
	}

	result.Stdout, result.StdoutTruncated = stdout.take()
	result.Stderr, result.StderrTruncated = stderr.take()
	if finished {
		if status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			result.Signal = status.Signal().String()
		} else {
			code := cmd.ProcessState.ExitCode()
			result.ExitCode = &code
		}
	} else {
		result.StillRunning = true
	}
	result.Running = int(s.live.Load())
	return result
}

func (s *Server) unstarted(result Result, reason string) Result {
	code := 127
	result.ExitCode = &code
	result.Stderr = reason
	result.Running = int(s.live.Load())
	return result
}

// environment is the whole environment of a command: PATH, HOME, LANG and TZ here, and PWD from os/exec (ADR 0019).
func environment(limits Limits) []string {
	env := []string{"PATH=" + limits.Path}
	for name, value := range map[string]string{"HOME": limits.Home, "LANG": limits.Lang, "TZ": limits.TimeZone} {
		if value != "" {
			env = append(env, name+"="+value)
		}
	}
	return env
}

// drain reads until the writers are gone. What arrives after the answer is thrown away by the frozen buffer, but it
// must still be read: an unread pipe fills and blocks the command that ADR 0019 promised to leave running.
func drain(file *os.File, into *capped, done *sync.WaitGroup) {
	defer done.Done()
	buffer := make([]byte, drainBuffer)
	for {
		read, err := file.Read(buffer)
		if read > 0 {
			_, _ = into.Write(buffer[:read])
		}
		if err != nil {
			return
		}
	}
}

func closeAll(files ...*os.File) {
	for _, file := range files {
		_ = file.Close()
	}
}

// SharedUmask is the umask of every command, the server's own (ADR 0033). The workspace may run as a UID other than
// the server's and share a group with it, so what a command makes is the group's to read and write, and nobody
// else's. The shared places are setgid directories, which keep new entries in that group.
const SharedUmask = 0o007

// UseSharedUmask gives the runner, and so every command it starts, the shared umask. It returns the previous one.
func UseSharedUmask() int {
	return syscall.Umask(SharedUmask)
}

// Listen takes over the socket path, then makes the socket connectable by its peer and its directory read-only, so a
// command running as the same user cannot remove or replace the socket. A missing directory is made, so the socket
// can sit in one of the runner's own on a volume it does not own, such as a Pod's memory-backed emptyDir (ADR 0033).
func Listen(path string) (net.Listener, error) {
	directory := filepath.Dir(path)
	if err := os.Mkdir(directory, 0o755); err != nil && !errors.Is(err, os.ErrExist) {
		return nil, err
	}
	if err := os.Chmod(directory, 0o755); err != nil {
		return nil, err
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("%s exists and is not a socket", path)
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o666); err != nil {
		_ = listener.Close()
		return nil, err
	}
	if err := os.Chmod(directory, 0o555); err != nil {
		_ = listener.Close()
		return nil, err
	}
	return listener, nil
}

func (s *Server) Serve(listener net.Listener) error {
	for {
		conn, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			return err
		}
		go s.handle(conn)
	}
}

func (s *Server) handle(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	line, _ := bufio.NewReader(io.LimitReader(conn, MaxRequestBytes+1)).ReadBytes('\n')
	var answer any
	// A command for bash, or a declared tool's argv with its input and timeout (ADR 0075). Only one of the two.
	var request struct {
		Command        string    `json:"command"`
		Argv           *[]string `json:"argv"`
		Stdin          *string   `json:"stdin"`
		TimeoutSeconds float64   `json:"timeoutSeconds"`
		TimeZone       string    `json:"timeZone"`
	}
	switch {
	case len(line) > MaxRequestBytes:
		answer = refusal{Error: "request too large"}
	case !bytes.HasSuffix(line, []byte("\n")):
		answer = refusal{Error: "request must be one JSON line"}
	case json.Unmarshal(line, &request) != nil:
		answer = refusal{Error: "request is not JSON"}
	case request.Argv != nil && request.Command != "":
		answer = refusal{Error: "request must have either command or argv"}
	case request.Argv != nil:
		if reason := argvRequest(*request.Argv); reason != "" {
			answer = refusal{Error: reason}
			break
		}
		stdin := ""
		if request.Stdin != nil {
			stdin = *request.Stdin
		}
		timeout := time.Duration(request.TimeoutSeconds * float64(time.Second))
		s.mu.Lock()
		answer = s.RunArgv(*request.Argv, stdin, timeout, request.TimeZone)
		s.mu.Unlock()
	case request.Stdin != nil:
		answer = refusal{Error: "stdin is only for argv"}
	case strings.TrimSpace(request.Command) == "":
		answer = refusal{Error: "command is empty"}
	default:
		s.mu.Lock()
		answer = s.Run(request.Command, request.TimeZone)
		s.mu.Unlock()
	}
	encoded, _ := json.Marshal(answer)
	// A command that ran to the response limit has already taken its time; the write itself is what is bounded here.
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, _ = conn.Write(append(encoded, '\n'))
}

// Check asks the runner at path to run a no-op, for the container's healthcheck.
func Check(path string, timeout time.Duration) error {
	conn, err := net.DialTimeout("unix", path, timeout)
	if err != nil {
		return err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))
	if _, err := conn.Write([]byte(`{"command":":"}` + "\n")); err != nil {
		return err
	}
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		return err
	}
	var result Result
	if err := json.Unmarshal(line, &result); err != nil {
		return err
	}
	if result.ExitCode == nil || *result.ExitCode != 0 {
		return fmt.Errorf("the runner did not run the check command")
	}
	return nil
}
