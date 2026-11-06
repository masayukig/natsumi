package main

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The host's own shell and tools stand in for the workspace's.
func limits(t *testing.T) Limits {
	t.Helper()
	return Limits{Shell: "/bin/bash", Path: "/usr/bin:/bin", Dir: t.TempDir(), Home: t.TempDir(), Lang: "C.UTF-8",
		TimeZone: "UTC", Response: 5 * time.Second, MaxOutput: 1 << 16}
}

func TestRunReturnsTheExitCodeAndStderr(t *testing.T) {
	result := (&Server{Limits: limits(t)}).Run("echo out; echo err >&2; exit 3", "")
	if result.ExitCode == nil || *result.ExitCode != 3 {
		t.Fatalf("exit code = %v, want 3", result.ExitCode)
	}
	if result.Stdout != "out\n" || result.Stderr != "err\n" {
		t.Fatalf("stdout %q stderr %q", result.Stdout, result.Stderr)
	}
	if result.StillRunning || result.StdoutTruncated || result.StderrTruncated || result.Signal != "" {
		t.Fatalf("unexpected flags: %+v", result)
	}
	if result.Running != 0 {
		t.Fatalf("running = %d, want 0 once nothing is left", result.Running)
	}
}

// The decision of ADR 0019: the response limit answers, it does not stop the command.
func TestRunAnswersAtTheResponseLimitAndLeavesTheCommandRunning(t *testing.T) {
	l := limits(t)
	l.Response = 300 * time.Millisecond
	server := &Server{Limits: l}
	marker := filepath.Join(l.Dir, "alive")
	started := time.Now()
	result := server.Run("echo before; sleep 5; touch "+marker, "")
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("took %v, want the response limit to answer", elapsed)
	}
	if !result.StillRunning || result.ExitCode != nil || result.Signal != "" {
		t.Fatalf("want a still-running answer: %+v", result)
	}
	if result.Stdout != "before\n" {
		t.Fatalf("output before the limit is kept, got %q", result.Stdout)
	}
	if result.ResponseLimitMs != 300 {
		t.Fatalf("responseLimitMs = %d", result.ResponseLimitMs)
	}
	if result.Running < 1 {
		t.Fatalf("running = %d, want the command still counted", result.Running)
	}
	// The process survives the answer, and the next command is taken meanwhile.
	next := server.Run("echo second", "")
	if next.ExitCode == nil || *next.ExitCode != 0 || next.Stdout != "second\n" {
		t.Fatalf("the runner takes the next command: %+v", next)
	}
	if next.Running < 1 {
		t.Fatalf("running = %d, want the earlier command still counted", next.Running)
	}
	deadline := time.Now().Add(15 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the command was killed: it never finished its work")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Output written after the answer is read and thrown away, so the pipe never fills and blocks the command.
func TestRunKeepsReadingTheOutputOfACommandItAlreadyAnsweredFor(t *testing.T) {
	l := limits(t)
	l.Response = 300 * time.Millisecond
	l.MaxOutput = 1 << 12
	server := &Server{Limits: l}
	marker := filepath.Join(l.Dir, "finished")
	// Far more than a pipe buffer holds: without draining, the command would block forever.
	result := server.Run("sleep 0.5; i=0; while [ $i -lt 5000 ]; do echo 0123456789012345678901234567890123456789; i=$((i+1)); done; touch "+marker, "")
	if !result.StillRunning {
		t.Fatalf("want a still-running answer: %+v", result)
	}
	deadline := time.Now().Add(20 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the command blocked: its output was not read after the answer")
		}
		time.Sleep(20 * time.Millisecond)
	}
	// What was read after the answer is not carried into any later answer.
	next := server.Run("echo plain", "")
	if next.Stdout != "plain\n" {
		t.Fatalf("stdout %q", next.Stdout)
	}
}

func TestRunDoesNotWaitForBackgroundChildrenAfterTheShellExits(t *testing.T) {
	started := time.Now()
	result := (&Server{Limits: limits(t)}).Run("sleep 30 & echo done", "")
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("took %v; a background child must not hold the command open", elapsed)
	}
	if result.StillRunning || result.ExitCode == nil || *result.ExitCode != 0 || result.Stdout != "done\n" {
		t.Fatalf("unexpected result: %+v", result)
	}
	// The child is left alive, and it is what the count is for.
	if result.Running < 1 {
		t.Fatalf("running = %d, want the background child counted", result.Running)
	}
}

func TestRunCutsOutputAtTheLimit(t *testing.T) {
	l := limits(t)
	l.MaxOutput = 100
	result := (&Server{Limits: l}).Run(`i=0; while [ $i -lt 2000 ]; do echo 0123456789; echo abcdefghij >&2; i=$((i+1)); done`, "")
	// The head and the tail together, within the limit (ADR 0094).
	if len(result.Stdout)+len(result.StdoutTail) != 100 || !result.StdoutTruncated {
		t.Fatalf("stdout %d+%d bytes, truncated %v", len(result.Stdout), len(result.StdoutTail), result.StdoutTruncated)
	}
	if len(result.Stderr)+len(result.StderrTail) != 100 || !result.StderrTruncated {
		t.Fatalf("stderr %d+%d bytes, truncated %v", len(result.Stderr), len(result.StderrTail), result.StderrTruncated)
	}
	if result.ExitCode == nil || *result.ExitCode != 0 {
		t.Fatalf("the command still runs to its end: %+v", result.ExitCode)
	}
}

// ADR 0019: PATH, PWD, HOME, LANG and TZ, and nothing else. SHLVL and _ are bash's own, set after it starts.
func TestRunGivesTheFiveEnvironmentVariablesAndNoInput(t *testing.T) {
	t.Setenv("NATSUMI_FAKE_SECRET", "must-not-leak")
	l := limits(t)
	l.Home = "/home/natsumi"
	l.TimeZone = "Asia/Tokyo"
	result := (&Server{Limits: l}).Run("env | sort; pwd; cat", "")
	lines := strings.Split(strings.TrimSuffix(result.Stdout, "\n"), "\n")
	if last := lines[len(lines)-1]; last != l.Dir {
		t.Fatalf("working directory %q, want %q", last, l.Dir)
	}
	var given []string
	for _, line := range lines[:len(lines)-1] {
		name := strings.SplitN(line, "=", 2)[0]
		if name == "SHLVL" || name == "_" {
			continue
		}
		given = append(given, line)
	}
	want := []string{"HOME=/home/natsumi", "LANG=C.UTF-8", "PATH=/usr/bin:/bin", "PWD=" + l.Dir, "TZ=Asia/Tokyo"}
	if strings.Join(given, "\n") != strings.Join(want, "\n") {
		t.Fatalf("environment %q, want %q", given, want)
	}
	// Nothing was read from standard input either: `cat` saw the end at once.
	if result.ExitCode == nil || *result.ExitCode != 0 {
		t.Fatalf("exit code %v; standard input must be empty, not a terminal", result.ExitCode)
	}
}

func TestRunTakesTheTimeZoneOfTheRequestAndRefusesAMalformedOne(t *testing.T) {
	l := limits(t)
	l.TimeZone = "UTC"
	server := &Server{Limits: l}
	result := server.Run("echo $TZ", "Asia/Tokyo")
	if result.Stdout != "Asia/Tokyo\n" {
		t.Fatalf("stdout %q", result.Stdout)
	}
	if fallback := server.Run("echo $TZ", "Asia/Tokyo; rm -rf /"); fallback.Stdout != "UTC\n" {
		t.Fatalf("a malformed time zone falls back to the runner's own: %q", fallback.Stdout)
	}
}

// bash, not sh: the tool description promises `bash -c`.
func TestRunUsesBashFeatures(t *testing.T) {
	result := (&Server{Limits: limits(t)}).Run("set -o pipefail; false | cat; echo code=$?", "")
	if !strings.Contains(result.Stdout, "code=1") {
		t.Fatalf("pipefail did not take: %q %q", result.Stdout, result.Stderr)
	}
}

func startServer(t *testing.T, l Limits) (string, *Server) {
	t.Helper()
	directory := filepath.Join(t.TempDir(), "socket")
	if err := os.Mkdir(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(directory, 0o755) })
	path := filepath.Join(directory, "runner.sock")
	listener, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	server := &Server{Limits: l}
	go func() { _ = server.Serve(listener) }()
	return path, server
}

func ask(t *testing.T, path string, request string) map[string]any {
	t.Helper()
	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	if _, err := conn.Write([]byte(request)); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		t.Fatalf("no answer: %v", err)
	}
	var answer map[string]any
	if err := json.Unmarshal(line, &answer); err != nil {
		t.Fatalf("answer is not JSON: %q", line)
	}
	return answer
}

func TestServeAnswersOneJSONLineOverTheUnixSocket(t *testing.T) {
	path, _ := startServer(t, limits(t))
	answer := ask(t, path, `{"command":"echo hi; echo oops >&2; exit 4"}`+"\n")
	if answer["exitCode"] != float64(4) || answer["stdout"] != "hi\n" || answer["stderr"] != "oops\n" || answer["stillRunning"] != false {
		t.Fatalf("answer: %v", answer)
	}
	if answer["running"] != float64(0) {
		t.Fatalf("running: %v", answer["running"])
	}
}

func TestListenLeavesTheSocketDirectoryReadOnlyAndTheSocketOpenToItsPeer(t *testing.T) {
	path, _ := startServer(t, limits(t))
	info, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o555 {
		t.Fatalf("socket directory mode %o, want 555 so commands cannot remove or replace the socket", info.Mode().Perm())
	}
	socket, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if socket.Mode()&os.ModeSocket == 0 || socket.Mode().Perm() != 0o666 {
		t.Fatalf("socket mode %v", socket.Mode())
	}
}

func TestListenReplacesAStaleSocket(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "socket")
	if err := os.Mkdir(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(directory, 0o755) })
	path := filepath.Join(directory, "runner.sock")
	first, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	first.(*net.UnixListener).SetUnlinkOnClose(false)
	_ = first.Close()
	second, err := Listen(path)
	if err != nil {
		t.Fatalf("a restarted runner must take over its old socket: %v", err)
	}
	_ = second.Close()
}

func TestServeRefusesMalformedAndOversizedRequests(t *testing.T) {
	path, _ := startServer(t, limits(t))
	if answer := ask(t, path, "not json\n"); answer["error"] == nil || answer["exitCode"] != nil {
		t.Fatalf("malformed: %v", answer)
	}
	if answer := ask(t, path, `{"command":""}`+"\n"); answer["error"] == nil {
		t.Fatalf("empty command: %v", answer)
	}
	if answer := ask(t, path, `{"command":"`+strings.Repeat("a", MaxRequestBytes)+`"}`+"\n"); answer["error"] == nil {
		t.Fatalf("oversized: %v", answer)
	}
}

// 8000 characters of Japanese is 24 KiB in UTF-8; the old 16 KiB limit refused what ADR 0018 allows.
func TestServeTakesEightThousandJapaneseCharacters(t *testing.T) {
	path, _ := startServer(t, limits(t))
	command := "echo " + strings.Repeat("あ", 7990)
	request, err := json.Marshal(map[string]string{"command": command})
	if err != nil {
		t.Fatal(err)
	}
	if len(request) <= 16<<10 {
		t.Fatalf("the request is %d bytes; it must be past the old 16 KiB limit to be a test", len(request))
	}
	answer := ask(t, path, string(request)+"\n")
	if answer["error"] != nil {
		t.Fatalf("refused: %v", answer)
	}
	if answer["exitCode"] != float64(0) {
		t.Fatalf("answer: %v", answer["exitCode"])
	}
}

func TestServeRunsOneCommandAtATime(t *testing.T) {
	l := limits(t)
	path, _ := startServer(t, l)
	marker := filepath.Join(l.Dir, "running")
	// Each command fails if it finds the other one running.
	command := `if [ -e running ]; then echo overlap; exit 9; fi; : > running; i=0; while [ $i -lt 20000 ]; do i=$((i+1)); done; rm running`
	done := make(chan map[string]any, 2)
	for range 2 {
		go func() { done <- ask(t, path, `{"command":`+quote(command)+`}`+"\n") }()
	}
	for range 2 {
		if answer := <-done; answer["exitCode"] != float64(0) {
			t.Fatalf("commands overlapped: %v", answer)
		}
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("marker left behind: %v", err)
	}
}

func TestCheckSucceedsOnlyWhileTheRunnerAnswers(t *testing.T) {
	path, _ := startServer(t, limits(t))
	if err := Check(path, 5*time.Second); err != nil {
		t.Fatalf("check: %v", err)
	}
	if err := Check(filepath.Join(t.TempDir(), "missing.sock"), time.Second); err == nil {
		t.Fatal("check must fail without a runner")
	}
}

func quote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// The workspace may run as a UID other than the server's, sharing a group with it (ADR 0033): what a command makes
// in /memory, /work and /home/natsumi must be writable by that group, and by nobody else.
func TestCommandsMakeFilesForTheSharedGroup(t *testing.T) {
	previous := UseSharedUmask()
	t.Cleanup(func() { syscall.Umask(previous) })
	l := limits(t)
	result := (&Server{Limits: l}).Run("umask; mkdir made; : > made/file", "")
	if result.ExitCode == nil || *result.ExitCode != 0 || result.Stdout != "0007\n" {
		t.Fatalf("result: %+v", result)
	}
	for name, want := range map[string]os.FileMode{"made": 0o770, "made/file": 0o660} {
		info, err := os.Stat(filepath.Join(l.Dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != want {
			t.Fatalf("%s mode %o, want %o", name, info.Mode().Perm(), want)
		}
	}
}

// In a Pod the socket lives on a volume the runner does not own, so it cannot change that directory's mode. It
// makes a directory of its own for the socket instead, when the configured one is not there yet.
func TestListenMakesAMissingSocketDirectory(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "runner")
	t.Cleanup(func() { _ = os.Chmod(directory, 0o755) })
	path := filepath.Join(directory, "runner.sock")
	listener, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	info, err := os.Stat(directory)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o555 {
		t.Fatalf("socket directory mode %o, want 555", info.Mode().Perm())
	}
	if socket, err := os.Stat(path); err != nil || socket.Mode()&os.ModeSocket == 0 {
		t.Fatalf("socket: %v", err)
	}
}
