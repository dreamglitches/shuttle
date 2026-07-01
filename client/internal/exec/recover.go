// Package exec — crash recovery for orphaned command tmux sessions.
// On startup, scans for any c-* tmux sessions left from a prior client crash,
// re-attaches output tracking, and resumes result collection.
package exec

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// RecoverOrphans finds any running c-* tmux sessions and re-registers them
// in the manager so output tracking resumes. Returns a list of recovered action IDs.
//
// The manager will POST partial results once the command finishes naturally;
// if the command already finished, it collects the final output immediately.
func (m *Manager) RecoverOrphans(tmuxBin string, onDone func(cmd *Command)) []string {
	sessions := listTmuxSessions(tmuxBin)
	var recovered []string

	for _, name := range sessions {
		if !strings.HasPrefix(name, "c-") {
			continue
		}
		// name format: c-<first8 of actionID>
		partial := name[2:] // the 8-char prefix

		// Create temp dir for output capture
		tempDir := filepath.Join(m.TempRoot, "exec-"+partial)
		outputFile := filepath.Join(tempDir, "out")

		// Ensure output dir exists (may not if crash was before dir creation)
		_ = os.MkdirAll(tempDir, 0o700)

		// Re-attach pipe-pane if the session is still running
		_ = exec.Command(tmuxBin, "pipe-pane", "-t", name,
			"-o", fmt.Sprintf("cat >> %s", outputFile)).Run()

		// Register a synthetic Command for this orphan
		ctx, cancel := context.WithCancel(context.Background())
		cmd := &Command{
			ActionID:   partial, // partial — we only have 8 chars; manager maps it
			TmuxName:   name,
			TmuxBin:    tmuxBin,
			TempDir:    tempDir,
			OutputFile: outputFile,
			cancel:     cancel,
		}

		m.mu.Lock()
		m.commands[partial] = cmd
		m.mu.Unlock()

		// Resume polling in background
		go func(c *Command, ctx context.Context) {
			c.poll(ctx)
			m.mu.Lock()
			delete(m.commands, c.ActionID)
			m.mu.Unlock()
			if onDone != nil {
				onDone(c)
			}
			_ = os.RemoveAll(c.TempDir)
		}(cmd, ctx)

		recovered = append(recovered, partial)
	}

	return recovered
}

func listTmuxSessions(tmuxBin string) []string {
	if tmuxBin == "" {
		tmuxBin = "tmux"
	}
	out, err := exec.Command(tmuxBin, "ls", "-F", "#{session_name}").Output()
	if err != nil {
		return nil
	}
	var sessions []string
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			sessions = append(sessions, line)
		}
	}
	return sessions
}
