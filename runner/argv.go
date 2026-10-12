package main

import (
	"errors"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// RunArgv runs one of the tools the config declares (ADR 0075): the program and its arguments as they are, with no
// shell between, the input on stdin, in the same directory and with the same five environment variables as a command.
//
// Unlike a command, a tool is stopped: past its timeout its whole process group is killed and the answer says it timed
// out. Once the program has ended, whatever it left in its group is killed too, so a tool's call is over when its
// answer is. The timeout is kept within the runner's response limit, so a tool holds the runner no longer than a
// command can.
func (s *Server) RunArgv(argv []string, stdin string, timeout time.Duration, timeZone string) Result {
	limits := s.limitsFor(timeZone)
	if timeout <= 0 || timeout > limits.Response {
		timeout = limits.Response
	}
	result := Result{ResponseLimitMs: timeout.Milliseconds()}
	stdout := &capped{max: limits.MaxOutput}
	stderr := &capped{max: limits.MaxOutput}

	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = limits.Dir
	// The five a command has; bash sets PWD for a command, and nothing does for a program started directly.
	cmd.Env = append(environment(limits), "PWD="+limits.Dir)
	cmd.Stdin = strings.NewReader(stdin)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// Something the program left behind may hold its pipes open; they are given up shortly after it exits.
	cmd.WaitDelay = flushDelay
	if err := cmd.Start(); err != nil {
		return s.unstarted(result, "the program could not be started: "+startError(err)+"\n")
	}
	s.live.Add(1)
	defer s.live.Add(-1)
	group := cmd.Process.Pid

	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-exited:
	case <-timer.C:
		result.TimedOut = true
	}
	// The group goes either way: past the timeout with the program in it, after an exit with whatever it left.
	_ = syscall.Kill(-group, syscall.SIGKILL)
	<-exited

	result.Stdout, result.StdoutTruncated = stdout.take()
	result.Stderr, result.StderrTruncated = stderr.take()
	if !result.TimedOut {
		if status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			result.Signal = status.Signal().String()
		} else {
			code := cmd.ProcessState.ExitCode()
			result.ExitCode = &code
		}
	}
	result.Running = int(s.live.Load()) - 1
	return result
}

// limitsFor is the runner's limits with the request's time zone, when it is a well-formed one.
func (s *Server) limitsFor(timeZone string) Limits {
	limits := s.Limits
	if timeZoneName.MatchString(timeZone) {
		limits.TimeZone = timeZone
	}
	return limits
}

// startError names why a program did not start without echoing its path back.
func startError(err error) string {
	switch {
	case errors.Is(err, syscall.ENOENT):
		return "no such file"
	case errors.Is(err, syscall.EACCES):
		return "permission denied"
	case errors.Is(err, syscall.ENOEXEC):
		return "not an executable"
	default:
		return "an error"
	}
}

// argvRequest checks the argv form of a request; an empty string means it may be run.
func argvRequest(argv []string) string {
	if len(argv) == 0 {
		return "argv is empty"
	}
	if !strings.HasPrefix(argv[0], "/") {
		return "the program must be an absolute path"
	}
	for _, arg := range argv {
		if strings.ContainsRune(arg, 0) {
			return "argv must not contain a NUL character"
		}
	}
	return ""
}
