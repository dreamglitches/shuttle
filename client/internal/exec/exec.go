// Package exec implements tmux-backed command execution.
// Commands run inside isolated tmux sessions (c-<action-id[:8]>) so they
// survive client restarts. Output is captured via tmux capture-pane polling.
package exec

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Command represents an in-flight command execution.
type Command struct {
	ActionID   string
	ServerID   string
	TmuxName   string // c-<first8 of ActionID>
	TmuxBin    string
	TempDir    string
	OutputFile string
	Done       bool
	ExitCode   int
	Output     string
	Error      string

	mu      sync.Mutex
	cancel  context.CancelFunc
}

// Manager tracks in-flight command executions.
type Manager struct {
	mu       sync.Mutex
	commands map[string]*Command
	TempRoot string
}

// NewManager creates a command execution manager.
func NewManager(tempRoot string) *Manager {
	return &Manager{
		commands: make(map[string]*Command),
		TempRoot: tempRoot,
	}
}

// Execute starts a command in a dedicated tmux session.
// Returns immediately; the command runs asynchronously.
// onDone is called when the command finishes (naturally or via timeout/kill).
func (m *Manager) Execute(
	actionID string,
	serverID string,
	cmdStr string,
	timeoutSec int,
	tmuxBinPath string,
	onDone func(cmd *Command),
) (*Command, error) {
	tmuxName := "c-" + actionID[:8]

	// Create temp dir for output capture
	tempDir := filepath.Join(m.TempRoot, "exec-"+actionID[:8])
	if err := os.MkdirAll(tempDir, 0o700); err != nil {
		return nil, fmt.Errorf("exec: mkdir: %w", err)
	}
	outputFile := filepath.Join(tempDir, "out")

	ctx, cancel := context.WithCancel(context.Background())

	cmd := &Command{
		ActionID:   actionID,
		ServerID:   serverID,
		TmuxName:   tmuxName,
		TmuxBin:    tmuxBinPath,
		TempDir:    tempDir,
		OutputFile: outputFile,
		cancel:     cancel,
	}

	m.mu.Lock()
	m.commands[actionID] = cmd
	m.mu.Unlock()

	go func() {
		defer cancel()
		cmd.run(ctx, cmdStr, timeoutSec)
		m.mu.Lock()
		delete(m.commands, actionID)
		m.mu.Unlock()
		if onDone != nil {
			onDone(cmd)
		}
		_ = os.RemoveAll(tempDir)
	}()

	return cmd, nil
}

// GetOutput returns the current captured output of a running command.
func (m *Manager) GetOutput(actionID string) (string, bool) {
	m.mu.Lock()
	cmd, ok := m.commands[actionID]
	m.mu.Unlock()
	if !ok {
		return "", false
	}
	cmd.mu.Lock()
	defer cmd.mu.Unlock()
	return cmd.Output, true
}

// Stop kills a running command's tmux session.
func (m *Manager) Stop(actionID string) (*Command, bool) {
	m.mu.Lock()
	cmd, ok := m.commands[actionID]
	m.mu.Unlock()
	if !ok {
		return nil, false
	}
	cmd.cancel()
	return cmd, true
}

// ─── Command execution ────────────────────────────────────────────────────────

func (c *Command) run(ctx context.Context, cmdStr string, timeoutSec int) {
	// Apply timeout if specified
	if timeoutSec > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(timeoutSec)*time.Second)
		defer cancel()
	}

	// Build the tmux command: start a new session running the shell command
	// Use pipe-pane to capture output to a file
	tmuxArgs := []string{
		"new-session", "-d", "-s", c.TmuxName,
		"-x", "220", "-y", "50",
		"--",
		"bash", "-c",
		fmt.Sprintf("%s; echo \"__EXIT_CODE:$?\" >> %s", cmdStr, c.OutputFile),
	}

	//nolint:gosec // cmd string comes from manager, controlled by operator
	startCmd := exec.CommandContext(ctx, c.TmuxBin, tmuxArgs...)
	startCmd.Env = sanitizeEnv(os.Environ())
	if err := startCmd.Run(); err != nil {
		c.mu.Lock()
		c.Error = fmt.Sprintf("tmux new-session: %v", err)
		c.Done = true
		c.mu.Unlock()
		return
	}

	// Set up pipe-pane to capture output
	//nolint:gosec
	_ = exec.Command(c.TmuxBin, "pipe-pane", "-t", c.TmuxName,
		"-o", fmt.Sprintf("cat >> %s", c.OutputFile)).Run()

	// Poll until done or context cancelled
	c.poll(ctx)
}

func (c *Command) poll(ctx context.Context) {
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			// Context cancelled (timeout or explicit stop)
			_ = exec.Command(c.TmuxBin, "kill-session", "-t", c.TmuxName).Run()
			c.mu.Lock()
			c.Done = true
			if ctx.Err() == context.DeadlineExceeded {
				c.Error = "timed_out"
			}
			c.mu.Unlock()
			return

		case <-ticker.C:
			// Read captured output
			data, err := os.ReadFile(c.OutputFile)
			if err == nil {
				output := string(data)
				// Check for exit code marker
				if idx := strings.LastIndex(output, "__EXIT_CODE:"); idx >= 0 {
					rest := output[idx+len("__EXIT_CODE:"):]
					output = output[:idx]
					var code int
					fmt.Sscanf(rest, "%d", &code)
					c.mu.Lock()
					c.Output = output
					c.ExitCode = code
					c.Done = true
					c.mu.Unlock()
					// Kill tmux session now that process is done
					_ = exec.Command(c.TmuxBin, "kill-session", "-t", c.TmuxName).Run()
					return
				}
				c.mu.Lock()
				c.Output = output
				c.mu.Unlock()
			}

			// Also check if tmux session still exists
			if !tmuxSessionExists(c.TmuxBin, c.TmuxName) {
				c.mu.Lock()
				if !c.Done {
					c.Done = true
				}
				c.mu.Unlock()
				return
			}
		}
	}
}

func tmuxSessionExists(tmuxBin, name string) bool {
	out, err := exec.Command(tmuxBin, "has-session", "-t", name).CombinedOutput()
	return err == nil && len(out) == 0
}

func sanitizeEnv(env []string) []string {
	blocked := map[string]bool{
		"HISTFILE":       true,
		"HISTSIZE":       true,
		"HISTFILESIZE":   true,
		"HISTCONTROL":    true,
		"HISTIGNORE":     true,
		"HISTTIMEFORMAT": true,
		"BASH_HISTORY":   true,
	}
	var clean []string
	for _, e := range env {
		key := strings.SplitN(e, "=", 2)[0]
		if !blocked[key] {
			clean = append(clean, e)
		}
	}
	clean = append(clean, "HISTFILE=/dev/null")
	return clean
}
