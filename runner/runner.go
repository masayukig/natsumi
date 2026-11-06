// Package main is the runner inside the natsumi workspace container (ADR 0011, ADR 0019).
//
// It listens on a Unix socket that natsumi reaches through a shared volume, runs each command with `bash -c` in the
// work directory, and answers with the exit code and the output so far. The confinement is the container's: no
// network, no secrets, and only the four writable places ADR 0019 lists.
//
// A command is never stopped. The response limit is the line at which the runner answers, not the line at which the
// command dies (ADR 0019): past it the answer says the command is still running, the process is left alone, and its
// output goes on being read so the pipe cannot fill and block it. A request may ask for a shorter wait, and may ask to
// be followed (ADR 0094): then the connection is kept open past the answer, and when the command ends its result is
// written on it as a second line. A command nobody follows has what it writes after the answer thrown away.
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
	"unicode/utf8"
)

// MaxRequestBytes bounds one request line. 8000 characters of Japanese is 24 KiB in UTF-8, and up to 48 KiB once
// JSON escaping has had its worst; 64 KiB holds that with room for the rest of the line (ADR 0019).
const MaxRequestBytes = 64 << 10

// After the shell exits, how long the runner waits for what is still in the pipes before it answers.
const flushDelay = 200 * time.Millisecond

// Bytes read from a command's pipe per read.
const drainBuffer = 32 << 10

// FollowLimit is how long a followed command is waited for after its answer (ADR 0094): as long as natsumi waits for
// an outside agent's reply. Past it the runner says the command is still running and stops keeping its output.
const FollowLimit = 24 * time.Hour

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
	// How long a followed command is waited for after its answer; FollowLimit when zero.
	Follow time.Duration
}

// Result is the answer to a command. ExitCode and Signal are empty while StillRunning is true: the command has not
// ended yet, so it has neither.
//
// An output longer than the runner keeps has its head in Stdout and its tail in StdoutTail, with the bytes thrown away
// between them in StdoutOmitted (ADR 0094); one that fitted is whole in Stdout. Stderr is kept the same way.
type Result struct {
	ExitCode        *int   `json:"exitCode"`
	Signal          string `json:"signal,omitempty"`
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
	StdoutTail      string `json:"stdoutTail,omitempty"`
	StderrTail      string `json:"stderrTail,omitempty"`
	StdoutOmitted   int64  `json:"stdoutOmitted"`
	StderrOmitted   int64  `json:"stderrOmitted"`
	StdoutTruncated bool   `json:"stdoutTruncated"`
	StderrTruncated bool   `json:"stderrTruncated"`
	// The wait was over and the command was left running: at the answer, or on a second line past the follow limit.
	StillRunning bool `json:"stillRunning"`
	// A declared tool's timeout was reached and its process group was killed (ADR 0075). Never set for a command.
	TimedOut bool `json:"timedOut"`
	// The response limit in milliseconds; a tool's timeout for a tool.
	ResponseLimitMs int64 `json:"responseLimitMs"`
	// How long this command was waited for before the answer: the request's wait within the response limit.
	WaitedMs int64 `json:"waitedMs"`
	// The command's process group, which `kill -- -<group>` stops whole.
	ProcessGroup int `json:"processGroup,omitempty"`
	// Commands this runner started that are still alive, this one included while it is.
	Running int `json:"running"`
	// Of those, the ones whose end will be written on a connection still open (ADR 0094).
	Following int `json:"following"`
}

type refusal struct {
	Error string `json:"error"`
}

// A time zone name, kept to what tzdata can hold so nothing odd reaches the environment of a command.
var timeZoneName = regexp.MustCompile(`^[A-Za-z0-9_+\-/]{1,64}$`)

// capped keeps the head and the tail of what is written, max bytes at most, and counts what it threw away between
// them (ADR 0094); with headOnly, the head alone, as a declared tool's result is kept. Once frozen it keeps nothing:
// nobody waits for the command any more, and what it writes from then on is read only to keep its pipe moving.
type capped struct {
	mu       sync.Mutex
	max      int
	headOnly bool
	head     []byte
	// The latest bytes past the head; more than the tail's room is held between trims.
	tail   []byte
	total  int64
	frozen bool
}

// output is what a capped buffer holds, as valid UTF-8: the whole of it in text, or the head in text and the tail in
// tail with the bytes between them omitted.
type output struct {
	text    string
	tail    string
	omitted int64
}

func (c *capped) headRoom() int {
	if c.headOnly {
		return c.max
	}
	return c.max / 2
}

func (c *capped) tailRoom() int {
	if c.headOnly {
		return 0
	}
	return c.max - c.max/2
}

func (c *capped) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.frozen {
		return len(p), nil
	}
	c.total += int64(len(p))
	rest := p
	if room := c.headRoom() - len(c.head); room > 0 {
		taken := min(room, len(rest))
		c.head = append(c.head, rest[:taken]...)
		rest = rest[taken:]
	}
	if tailRoom := c.tailRoom(); tailRoom > 0 && len(rest) > 0 {
		c.tail = append(c.tail, rest...)
		if len(c.tail) > 2*tailRoom {
			c.tail = append([]byte(nil), c.tail[len(c.tail)-tailRoom:]...)
		}
	}
	return len(p), nil
}

// snapshot is what the buffer holds now. A character cut where the head ends or the tail begins is left out, and
// counted with what was omitted.
func (c *capped) snapshot() output {
	c.mu.Lock()
	defer c.mu.Unlock()
	head := c.head
	tail := c.tail
	if room := c.tailRoom(); len(tail) > room {
		tail = tail[len(tail)-room:]
	}
	omitted := c.total - int64(len(head)) - int64(len(tail))
	if omitted == 0 {
		return output{text: strings.ToValidUTF8(string(head)+string(tail), "\uFFFD")}
	}
	if c.headOnly {
		return output{text: strings.ToValidUTF8(string(head), "\uFFFD"), omitted: omitted}
	}
	keptHead := wholeHead(head)
	keptTail := wholeTail(tail)
	omitted += int64(len(head)-len(keptHead)) + int64(len(tail)-len(keptTail))
	return output{text: strings.ToValidUTF8(string(keptHead), "\uFFFD"), tail: strings.ToValidUTF8(string(keptTail), "\uFFFD"), omitted: omitted}
}

// take freezes the buffer and returns what it holds.
func (c *capped) take() output {
	out := c.snapshot()
	c.freeze()
	return out
}

func (c *capped) freeze() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.frozen = true
	c.head = nil
	c.tail = nil
}

// wholeHead is a head without a character cut at its end.
func wholeHead(b []byte) []byte {
	for back := 1; back <= utf8.UTFMax && back <= len(b); back++ {
		at := len(b) - back
		if !utf8.RuneStart(b[at]) {
			continue
		}
		if !utf8.FullRune(b[at:]) {
			return b[:at]
		}
		break
	}
	return b
}

// wholeTail is a tail without a character cut at its start.
func wholeTail(b []byte) []byte {
	for skip := 0; skip < utf8.UTFMax && skip < len(b); skip++ {
		if utf8.RuneStart(b[skip]) {
			return b[skip:]
		}
	}
	return b
}

// Server answers one JSON request line per connection and waits on one command at a time. Commands it has already
// answered for go on running outside the lock.
type Server struct {
	Limits    Limits
	mu        sync.Mutex
	live      atomic.Int64
	following atomic.Int64
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

// started is a command under way: its process, its kept output, and the signs of its end.
type started struct {
	server *Server
	limits Limits
	cmd    *exec.Cmd
	stdout *capped
	stderr *capped
	// Closed when the shell has exited, and when the output has reached its end.
	exited chan struct{}
	ended  chan struct{}
	entry  *liveCommand
}

// Run runs one command in its own process group and answers when it ends or when the response limit is reached,
// whichever comes first. Nothing is killed either way.
func (s *Server) Run(command string, timeZone string) Result {
	return s.RunFor(command, timeZone, nil)
}

// RunFor is Run with a wait of the caller's choosing, kept within 0 and the response limit; nil waits the limit.
func (s *Server) RunFor(command string, timeZone string, wait *time.Duration) Result {
	run, result := s.start(command, timeZone)
	if run == nil {
		return result
	}
	result = run.answer(wait)
	run.letGo()
	result.Running = int(s.live.Load())
	result.Following = int(s.following.Load())
	return result
}

// start starts a command, or answers why it could not be.
func (s *Server) start(command string, timeZone string) (*started, Result) {
	limits := s.limitsFor(timeZone)
	result := Result{ResponseLimitMs: limits.Response.Milliseconds()}

	outRead, outWrite, err := os.Pipe()
	if err != nil {
		return nil, s.unstarted(result, "the runner could not open a pipe\n")
	}
	errRead, errWrite, err := os.Pipe()
	if err != nil {
		closeAll(outRead, outWrite)
		return nil, s.unstarted(result, "the runner could not open a pipe\n")
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
		return nil, s.unstarted(result, "the shell could not be started\n")
	}
	// The runner holds no write end of its own, so the pipes end when the command and everything it left have let go.
	closeAll(outWrite, errWrite)

	run := &started{server: s, limits: limits, cmd: cmd, stdout: &capped{max: limits.MaxOutput}, stderr: &capped{max: limits.MaxOutput},
		exited: make(chan struct{}), ended: make(chan struct{})}
	var drains sync.WaitGroup
	drains.Add(2)
	go drain(outRead, run.stdout, &drains)
	go drain(errRead, run.stderr, &drains)

	s.live.Add(1)
	run.entry = &liveCommand{server: s}
	go func() { _ = cmd.Wait(); close(run.exited) }()
	go func() { drains.Wait(); close(run.ended) }()
	// Whatever happens above, the command stops counting once it is over and its output has run out.
	go func() {
		<-run.exited
		<-run.ended
		closeAll(outRead, errRead)
		run.entry.release()
	}()
	return run, result
}

// answer waits for the command until it ends or the wait is over, and says how it stands. A command that is over
// already is answered with its result, whatever the wait.
func (r *started) answer(wait *time.Duration) Result {
	limit := r.limits.Response
	if wait != nil {
		limit = max(0, min(*wait, r.limits.Response))
	}
	result := Result{ResponseLimitMs: r.limits.Response.Milliseconds(), WaitedMs: limit.Milliseconds(), ProcessGroup: r.cmd.Process.Pid}
	finished := false
	select {
	case <-r.exited:
		finished = true
	default:
		timer := time.NewTimer(limit)
		select {
		case <-r.exited:
			finished = true
		case <-timer.C:
		}
		timer.Stop()
	}
	if !finished {
		r.fill(&result)
		result.StillRunning = true
		return result
	}
	r.settle(&result)
	return result
}

// settle gives the result of a command whose shell has exited. What the shell wrote just before it exited is still in
// the pipe; anything it left behind holds them open, and is not waited for past a moment.
func (r *started) settle(result *Result) {
	select {
	case <-r.ended:
		r.entry.release()
	case <-time.After(flushDelay):
	}
	r.fill(result)
	if status, ok := r.cmd.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		result.Signal = status.Signal().String()
	} else {
		code := r.cmd.ProcessState.ExitCode()
		result.ExitCode = &code
	}
}

// fill puts the output kept so far into the result.
func (r *started) fill(result *Result) {
	stdout := r.stdout.snapshot()
	stderr := r.stderr.snapshot()
	result.Stdout, result.StdoutTail, result.StdoutOmitted, result.StdoutTruncated = stdout.text, stdout.tail, stdout.omitted, stdout.omitted > 0
	result.Stderr, result.StderrTail, result.StderrOmitted, result.StderrTruncated = stderr.text, stderr.tail, stderr.omitted, stderr.omitted > 0
}

// letGo stops keeping the output: nobody will be told of the command any more. It goes on running, and its pipes on
// being read.
func (r *started) letGo() {
	r.stdout.freeze()
	r.stderr.freeze()
}

// follow waits for a command already answered for, on the connection the answer went out on (ADR 0094). When it ends
// its result is written there as a second line; past the follow limit, a line that says it is still running. Either
// way the output is let go after. A connection the server closes is let go of at once, with nothing written.
func (r *started) follow(conn net.Conn) {
	defer r.letGo()
	limit := r.limits.Follow
	if limit <= 0 {
		limit = FollowLimit
	}
	_ = conn.SetReadDeadline(time.Time{})
	gone := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, conn)
		close(gone)
	}()
	timer := time.NewTimer(limit)
	defer timer.Stop()
	result := Result{ResponseLimitMs: r.limits.Response.Milliseconds(), ProcessGroup: r.cmd.Process.Pid}
	select {
	case <-gone:
		return
	case <-r.exited:
		r.settle(&result)
	case <-timer.C:
		r.fill(&result)
		result.StillRunning = true
	}
	result.Running = int(r.server.live.Load())
	result.Following = int(r.server.following.Load())
	writeLine(conn, result)
}

func (s *Server) unstarted(result Result, reason string) Result {
	code := 127
	result.ExitCode = &code
	result.Stderr = reason
	result.Running = int(s.live.Load())
	result.Following = int(s.following.Load())
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
	// A command may come with a wait of its own and ask to be followed past its answer (ADR 0094).
	var request struct {
		Command        string    `json:"command"`
		Argv           *[]string `json:"argv"`
		Stdin          *string   `json:"stdin"`
		TimeoutSeconds float64   `json:"timeoutSeconds"`
		TimeZone       string    `json:"timeZone"`
		WaitSeconds    *float64  `json:"waitSeconds"`
		Follow         bool      `json:"follow"`
	}
	var followed *started
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
		var wait *time.Duration
		if request.WaitSeconds != nil {
			chosen := time.Duration(*request.WaitSeconds * float64(time.Second))
			wait = &chosen
		}
		s.mu.Lock()
		run, result := s.start(request.Command, request.TimeZone)
		if run != nil {
			result = run.answer(wait)
			if request.Follow && result.StillRunning {
				followed = run
				s.following.Add(1)
				defer s.following.Add(-1)
			} else {
				run.letGo()
			}
			result.Running = int(s.live.Load())
			result.Following = int(s.following.Load())
		}
		s.mu.Unlock()
		answer = result
	}
	writeLine(conn, answer)
	if followed != nil {
		followed.follow(conn)
	}
}

// writeLine writes one answer line. A command that ran to its wait has already taken its time; the write itself is
// what is bounded here.
func writeLine(conn net.Conn, answer any) {
	encoded, _ := json.Marshal(answer)
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
