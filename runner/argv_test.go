package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A script in place of one of the owner's tools under /tools (ADR 0075).
func script(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tool")
	if err := os.WriteFile(path, []byte("#!/bin/bash\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRunArgvHandsTheInputOnStdinAndReturnsStdout(t *testing.T) {
	tool := script(t, `read -r line; echo "got $line"; echo "args $*"; echo note >&2`)
	result := (&Server{Limits: limits(t)}).RunArgv([]string{tool, "a b", "$HOME"}, `{"city":"Tokyo"}`, time.Second, "")
	if result.ExitCode == nil || *result.ExitCode != 0 {
		t.Fatalf("exit code = %v: %+v", result.ExitCode, result)
	}
	if result.Stdout != "got {\"city\":\"Tokyo\"}\nargs a b $HOME\n" || result.Stderr != "note\n" {
		t.Fatalf("stdout %q stderr %q", result.Stdout, result.Stderr)
	}
	if result.TimedOut || result.StillRunning || result.Signal != "" {
		t.Fatalf("unexpected flags: %+v", result)
	}
}

// No shell sits between the request and the program: what would be a pipe or a substitution to bash is one argument.
func TestRunArgvDoesNotGoThroughAShell(t *testing.T) {
	result := (&Server{Limits: limits(t)}).RunArgv([]string{"/bin/echo", "$(id)", "|", "cat"}, "", time.Second, "")
	if result.Stdout != "$(id) | cat\n" {
		t.Fatalf("stdout %q", result.Stdout)
	}
}

func TestRunArgvReturnsAFailingExitCode(t *testing.T) {
	tool := script(t, `echo partial; echo broken >&2; exit 5`)
	result := (&Server{Limits: limits(t)}).RunArgv([]string{tool}, "", time.Second, "")
	if result.ExitCode == nil || *result.ExitCode != 5 || result.Stdout != "partial\n" || result.Stderr != "broken\n" {
		t.Fatalf("result: %+v", result)
	}
}

// ADR 0075: past its time the tool is stopped, children and all, and the answer is a failure, not "still running".
func TestRunArgvStopsTheProcessGroupAtItsTimeout(t *testing.T) {
	l := limits(t)
	marker := filepath.Join(l.Dir, "survived")
	tool := script(t, `echo before; (sleep 2; touch `+marker+`) & sleep 5`)
	server := &Server{Limits: l}
	started := time.Now()
	result := server.RunArgv([]string{tool}, "", 300*time.Millisecond, "")
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("took %v, want the timeout to answer", elapsed)
	}
	if !result.TimedOut || result.StillRunning || result.ExitCode != nil {
		t.Fatalf("want a timed-out answer: %+v", result)
	}
	if result.Stdout != "before\n" {
		t.Fatalf("output before the timeout is kept, got %q", result.Stdout)
	}
	if result.ResponseLimitMs != 300 {
		t.Fatalf("responseLimitMs = %d", result.ResponseLimitMs)
	}
	time.Sleep(2500 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a child of the tool outlived its timeout")
	}
	if result.Running != 0 {
		t.Fatalf("running = %d, want nothing counted", result.Running)
	}
}

// A request cannot wait longer than the runner's own response limit, so a tool holds the runner no longer than a command.
func TestRunArgvKeepsTheTimeoutWithinTheResponseLimit(t *testing.T) {
	l := limits(t)
	l.Response = 300 * time.Millisecond
	started := time.Now()
	result := (&Server{Limits: l}).RunArgv([]string{"/bin/sleep", "5"}, "", time.Hour, "")
	if elapsed := time.Since(started); elapsed > 2*time.Second || !result.TimedOut || result.ResponseLimitMs != 300 {
		t.Fatalf("took %v: %+v", elapsed, result)
	}
}

// Whatever the tool left in its group is gone once it has answered: a tool's call is over when its answer is.
func TestRunArgvLeavesNothingBehindAfterItEnds(t *testing.T) {
	l := limits(t)
	marker := filepath.Join(l.Dir, "left")
	tool := script(t, `(sleep 1; touch `+marker+`) >/dev/null 2>&1 & echo done`)
	result := (&Server{Limits: l}).RunArgv([]string{tool}, "", 2*time.Second, "")
	if result.ExitCode == nil || *result.ExitCode != 0 || result.Stdout != "done\n" {
		t.Fatalf("result: %+v", result)
	}
	time.Sleep(1500 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a child of the tool outlived its answer")
	}
}

// A tool that never reads its input still ends: the input it left unread does not hold it.
func TestRunArgvDoesNotHangOnInputThatIsNotRead(t *testing.T) {
	result := (&Server{Limits: limits(t)}).RunArgv([]string{"/bin/echo", "ok"}, strings.Repeat("x", 1<<20), 2*time.Second, "")
	if result.ExitCode == nil || *result.ExitCode != 0 || result.Stdout != "ok\n" {
		t.Fatalf("result: %+v", result)
	}
}

func TestRunArgvGivesTheFiveEnvironmentVariables(t *testing.T) {
	t.Setenv("NATSUMI_FAKE_SECRET", "must-not-leak")
	l := limits(t)
	l.Home = "/home/natsumi"
	result := (&Server{Limits: l}).RunArgv([]string{"/usr/bin/env"}, "", time.Second, "Asia/Tokyo")
	lines := strings.Split(strings.TrimSuffix(result.Stdout, "\n"), "\n")
	want := []string{"HOME=/home/natsumi", "LANG=C.UTF-8", "PATH=/usr/bin:/bin", "PWD=" + l.Dir, "TZ=Asia/Tokyo"}
	if strings.Join(sorted(lines), "\n") != strings.Join(want, "\n") {
		t.Fatalf("environment %q, want %q", lines, want)
	}
}

func TestRunArgvAnswersAProgramThatCannotStart(t *testing.T) {
	result := (&Server{Limits: limits(t)}).RunArgv([]string{"/nonexistent/tool"}, "", time.Second, "")
	if result.ExitCode == nil || *result.ExitCode != 127 || result.Stderr == "" {
		t.Fatalf("result: %+v", result)
	}
}

func TestServeTakesAnArgvRequest(t *testing.T) {
	path, _ := startServer(t, limits(t))
	tool := script(t, `cat`)
	answer := ask(t, path, `{"argv":[`+quote(tool)+`],"stdin":"{\"a\":1}","timeoutSeconds":2}`+"\n")
	if answer["exitCode"] != float64(0) || answer["stdout"] != `{"a":1}` || answer["timedOut"] != false {
		t.Fatalf("answer: %v", answer)
	}
}

func TestServeRefusesMalformedArgvRequests(t *testing.T) {
	path, _ := startServer(t, limits(t))
	for name, request := range map[string]string{
		"empty argv":           `{"argv":[]}`,
		"relative program":     `{"argv":["tool"]}`,
		"both forms":           `{"argv":["/bin/true"],"command":"true"}`,
		"a NUL":                `{"argv":["/bin/echo","a\u0000b"]}`,
		"stdin with a command": `{"command":"cat","stdin":"x"}`,
	} {
		if answer := ask(t, path, request+"\n"); answer["error"] == nil {
			t.Fatalf("%s: %v", name, answer)
		}
	}
}

func sorted(lines []string) []string {
	out := append([]string(nil), lines...)
	for i := range out {
		for j := i + 1; j < len(out); j++ {
			if out[j] < out[i] {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}
