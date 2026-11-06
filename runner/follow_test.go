package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
	"unicode/utf8"
)

// ADR 0094: the output keeps its head and its tail, and what lies between is thrown away and counted.
func TestCappedKeepsEverythingUpToItsLimit(t *testing.T) {
	c := &capped{max: 100}
	for range 10 {
		_, _ = c.Write([]byte("0123456789"))
	}
	out := c.snapshot()
	if out.text != strings.Repeat("0123456789", 10) || out.tail != "" || out.omitted != 0 {
		t.Fatalf("snapshot %+v", out)
	}
}

func TestCappedKeepsTheHeadAndTheTailOfALongOutput(t *testing.T) {
	c := &capped{max: 100}
	var all strings.Builder
	for i := range 300 {
		piece := string(rune('a'+i%26)) + "123456"
		all.WriteString(piece)
		_, _ = c.Write([]byte(piece))
	}
	whole := all.String()
	out := c.snapshot()
	if out.text != whole[:50] {
		t.Fatalf("head %q, want %q", out.text, whole[:50])
	}
	if out.tail != whole[len(whole)-50:] {
		t.Fatalf("tail %q, want %q", out.tail, whole[len(whole)-50:])
	}
	if out.omitted != int64(len(whole)-100) {
		t.Fatalf("omitted %d, want %d", out.omitted, len(whole)-100)
	}
}

func TestCappedNeverCutsACharacterInTwo(t *testing.T) {
	c := &capped{max: 100}
	text := strings.Repeat("あいう", 200)
	_, _ = c.Write([]byte(text))
	out := c.snapshot()
	for _, part := range []string{out.text, out.tail} {
		if !utf8.ValidString(part) || strings.ContainsRune(part, utf8.RuneError) {
			t.Fatalf("a character was cut: %q", part)
		}
	}
	if !strings.HasPrefix(text, out.text) || !strings.HasSuffix(text, out.tail) {
		t.Fatalf("head %q tail %q are not the ends of the output", out.text, out.tail)
	}
	if int64(len(out.text)+len(out.tail))+out.omitted != int64(len(text)) {
		t.Fatalf("head %d + tail %d + omitted %d != %d", len(out.text), len(out.tail), out.omitted, len(text))
	}
}

// The tail of a long output is where errors and totals usually are.
func TestRunKeepsTheEndOfALongOutput(t *testing.T) {
	l := limits(t)
	l.MaxOutput = 200
	result := (&Server{Limits: l}).Run(`for i in $(seq 1 2000); do echo "line $i"; done; echo total=2000; echo failed-at-the-end >&2`, "")
	if !strings.HasPrefix(result.Stdout, "line 1\nline 2\n") {
		t.Fatalf("head %q", result.Stdout)
	}
	if !strings.HasSuffix(result.StdoutTail, "line 2000\ntotal=2000\n") {
		t.Fatalf("tail %q", result.StdoutTail)
	}
	if result.StdoutOmitted <= 0 || !result.StdoutTruncated {
		t.Fatalf("omitted %d truncated %v", result.StdoutOmitted, result.StdoutTruncated)
	}
	if len(result.Stdout)+len(result.StdoutTail) > l.MaxOutput {
		t.Fatalf("kept %d bytes, more than the limit %d", len(result.Stdout)+len(result.StdoutTail), l.MaxOutput)
	}
	if result.Stderr != "failed-at-the-end\n" || result.StderrTail != "" || result.StderrOmitted != 0 {
		t.Fatalf("stderr %q tail %q omitted %d", result.Stderr, result.StderrTail, result.StderrOmitted)
	}
}

// A declared tool's output is its result: it is still cut from the head alone (ADR 0075 is not changed).
func TestRunArgvStillKeepsTheHeadOnly(t *testing.T) {
	l := limits(t)
	l.MaxOutput = 100
	result := (&Server{Limits: l}).RunArgv([]string{"/bin/bash", "-c", "seq 1 1000"}, "", time.Second, "")
	if len(result.Stdout) != 100 || result.StdoutTail != "" || !result.StdoutTruncated || !strings.HasPrefix(result.Stdout, "1\n2\n") {
		t.Fatalf("stdout %q tail %q", result.Stdout, result.StdoutTail)
	}
}

func TestRunForWaitsTheChosenTimeAndSaysHowLong(t *testing.T) {
	server := &Server{Limits: limits(t)}
	wait := 200 * time.Millisecond
	started := time.Now()
	result := server.RunFor("echo before; sleep 3", "", &wait)
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("took %v, want the chosen wait", elapsed)
	}
	if !result.StillRunning || result.WaitedMs != 200 || result.ResponseLimitMs != 5000 {
		t.Fatalf("result %+v", result)
	}
	if result.ProcessGroup <= 0 {
		t.Fatalf("processGroup %d", result.ProcessGroup)
	}
	_ = syscall.Kill(-result.ProcessGroup, syscall.SIGKILL)
}

func TestRunForKeepsTheWaitWithinZeroAndTheResponseLimit(t *testing.T) {
	l := limits(t)
	l.Response = 300 * time.Millisecond
	server := &Server{Limits: l}
	long := time.Hour
	if result := server.RunFor("sleep 3", "", &long); result.WaitedMs != 300 || !result.StillRunning {
		t.Fatalf("a wait past the limit waits the limit: %+v", result)
	}
	negative := -5 * time.Second
	started := time.Now()
	if result := server.RunFor("sleep 3", "", &negative); result.WaitedMs != 0 || !result.StillRunning {
		t.Fatalf("a negative wait waits nothing: %+v", result)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("took %v", elapsed)
	}
	if result := server.RunFor("sleep 3", "", nil); result.WaitedMs != 300 {
		t.Fatalf("no wait given waits the limit: %+v", result)
	}
}

// Reads every line the runner writes on one connection until it closes it.
func exchange(t *testing.T, path, request string, after func(first map[string]any, conn net.Conn)) []map[string]any {
	t.Helper()
	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	if _, err := conn.Write([]byte(request + "\n")); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	var lines []map[string]any
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			var answer map[string]any
			if jsonErr := json.Unmarshal(line, &answer); jsonErr != nil {
				t.Fatalf("not JSON: %q", line)
			}
			lines = append(lines, answer)
			if len(lines) == 1 && after != nil {
				after(answer, conn)
			}
		}
		if err == io.EOF {
			return lines
		}
		if err != nil {
			t.Fatalf("reading: %v (after %d lines)", err, len(lines))
		}
	}
}

// ADR 0094: a command left running on a connection kept open is told on the same connection, in a second line.
func TestServeWritesASecondLineWhenAFollowedCommandEnds(t *testing.T) {
	path, _ := startServer(t, limits(t))
	lines := exchange(t, path, `{"command":"echo early; sleep 0.5; echo late; echo oops >&2; exit 7","waitSeconds":0.1,"follow":true}`, nil)
	if len(lines) != 2 {
		t.Fatalf("lines %v", lines)
	}
	first, second := lines[0], lines[1]
	if first["stillRunning"] != true || first["stdout"] != "early\n" || first["following"] != float64(1) {
		t.Fatalf("first %v", first)
	}
	if group, _ := first["processGroup"].(float64); group <= 0 {
		t.Fatalf("processGroup %v", first["processGroup"])
	}
	if second["stillRunning"] != false || second["exitCode"] != float64(7) {
		t.Fatalf("second %v", second)
	}
	// The whole output from the start, not only what came after the first answer.
	if second["stdout"] != "early\nlate\n" || second["stderr"] != "oops\n" {
		t.Fatalf("second output %q %q", second["stdout"], second["stderr"])
	}
	if second["processGroup"] != first["processGroup"] {
		t.Fatalf("process group changed: %v %v", first["processGroup"], second["processGroup"])
	}
}

func TestServeAnswersAFollowedCommandThatEndsInTimeWithOneLine(t *testing.T) {
	path, _ := startServer(t, limits(t))
	lines := exchange(t, path, `{"command":"echo quick","waitSeconds":5,"follow":true}`, nil)
	if len(lines) != 1 || lines[0]["exitCode"] != float64(0) || lines[0]["stdout"] != "quick\n" {
		t.Fatalf("lines %v", lines)
	}
}

func TestServeNamesTheSignalAFollowedCommandEndedBy(t *testing.T) {
	path, _ := startServer(t, limits(t))
	lines := exchange(t, path, `{"command":"sleep 20","waitSeconds":0.1,"follow":true}`, func(first map[string]any, _ net.Conn) {
		group := int(first["processGroup"].(float64))
		if err := syscall.Kill(-group, syscall.SIGKILL); err != nil {
			t.Errorf("kill: %v", err)
		}
	})
	if len(lines) != 2 || lines[1]["exitCode"] != nil || lines[1]["signal"] != "killed" {
		t.Fatalf("lines %v", lines)
	}
}

// The runner does not wait for ever: past its follow limit (24 hours in the workspace) it says it is still running,
// stops keeping the output, and leaves the command alone.
func TestServeGivesUpFollowingAtItsLimitAndLeavesTheCommandRunning(t *testing.T) {
	l := limits(t)
	l.Follow = 300 * time.Millisecond
	path, server := startServer(t, l)
	marker := filepath.Join(l.Dir, "alive")
	lines := exchange(t, path, `{"command":"sleep 1.5; touch alive","waitSeconds":0.1,"follow":true}`, nil)
	if len(lines) != 2 || lines[1]["stillRunning"] != true || lines[1]["exitCode"] != nil {
		t.Fatalf("lines %v", lines)
	}
	waitFor(t, func() bool { return server.following.Load() == 0 }, "the follow was not let go")
	waitFor(t, func() bool { _, err := os.Stat(marker); return err == nil }, "the command was stopped")
}

// When the server lets go of the connection (it is waiting on as many as it may), the runner stops keeping the output
// and the command goes on as one nobody waits for.
func TestServeStopsFollowingWhenTheServerLetsGo(t *testing.T) {
	l := limits(t)
	path, server := startServer(t, l)
	marker := filepath.Join(l.Dir, "alive")
	lines := exchange(t, path, `{"command":"sleep 1; touch alive","waitSeconds":0.1,"follow":true}`, func(_ map[string]any, conn net.Conn) {
		_ = conn.(*net.UnixConn).CloseWrite()
	})
	if len(lines) != 1 {
		t.Fatalf("lines %v", lines)
	}
	waitFor(t, func() bool { return server.following.Load() == 0 }, "the follow was not let go")
	waitFor(t, func() bool { _, err := os.Stat(marker); return err == nil }, "the command was stopped")
}

// Following one command does not hold the runner: the next request is taken while it runs.
func TestServeTakesTheNextCommandWhileFollowingOne(t *testing.T) {
	path, _ := startServer(t, limits(t))
	done := make(chan []map[string]any, 1)
	go func() {
		done <- exchange(t, path, `{"command":"sleep 1; echo first","waitSeconds":0.1,"follow":true}`, nil)
	}()
	time.Sleep(300 * time.Millisecond)
	next := ask(t, path, `{"command":"echo second"}`+"\n")
	if next["stdout"] != "second\n" || next["following"] != float64(1) {
		t.Fatalf("next %v", next)
	}
	lines := <-done
	if len(lines) != 2 || lines[1]["stdout"] != "first\n" {
		t.Fatalf("lines %v", lines)
	}
}

// Without follow, nothing changes: one line, and the connection is closed (the curator, and every older server).
func TestServeWithoutFollowClosesAfterOneLine(t *testing.T) {
	path, _ := startServer(t, limits(t))
	started := time.Now()
	lines := exchange(t, path, `{"command":"sleep 3","waitSeconds":0.1}`, nil)
	if len(lines) != 1 || lines[0]["stillRunning"] != true || lines[0]["following"] != float64(0) {
		t.Fatalf("lines %v", lines)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("took %v", elapsed)
	}
}

func waitFor(t *testing.T, done func() bool, failure string) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !done() {
		if time.Now().After(deadline) {
			t.Fatal(failure)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
