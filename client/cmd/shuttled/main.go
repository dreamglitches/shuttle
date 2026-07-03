// shuttled — Shuttle Fleet Client Daemon
//
// Build for release (zero stdout/stderr):
//
//	go build -tags release \
//	  -ldflags "-X github.com/shuttle-fleet/shuttle/client/internal/auth.PSK=<your-psk> \
//	            -s -w" \
//	  -o shuttled ./cmd/shuttled
//
// The PSK is the only secret needed. No config files, no credential files.
// Zero on-disk fingerprint except the binary and systemd unit.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"

	"github.com/dreamglitches/shuttle/client/internal/action"
	clientAuth "github.com/dreamglitches/shuttle/client/internal/auth"
	"github.com/dreamglitches/shuttle/client/internal/beacon"
	"github.com/dreamglitches/shuttle/client/internal/exec"
	"github.com/dreamglitches/shuttle/client/internal/identity"
	"github.com/dreamglitches/shuttle/client/internal/session"
	"github.com/dreamglitches/shuttle/client/internal/update"
)

// Version is set at build time via -ldflags.
var Version = "dev"

// DefaultManagerURL is the primary manager URL, set at build time.
// Override per-fleet via -ldflags or via settings propagation at runtime.
var DefaultManagerURL = "https://shuttle-manager.PLACEHOLDER.workers.dev"

// DefaultFallbackURL is the fallback manager URL.
var DefaultFallbackURL = ""

func main() {
	// --rollback-check: called by ExecStopPost in the systemd unit.
	// Must run before anything else so it can exit early if needed.
	if len(os.Args) > 1 && os.Args[1] == "--rollback-check" {
		installPath, _ := os.Executable()
		update.RollbackCheck(installPath)
		return
	}

	// Validate PSK is set
	if clientAuth.PSK == "" {
		logf("FATAL: PSK not set — rebuild with -ldflags \"-X .../auth.PSK=<value>\"")
		os.Exit(1)
	}

	// Derive stable server ID
	serverID, err := identity.DeriveServerID()
	if err != nil {
		logf("FATAL: cannot derive server ID: %v", err)
		os.Exit(1)
	}

	// Create ephemeral temp root (mode 700, deleted on clean exit)
	tempRoot := filepath.Join(os.TempDir(), "."+session.RandomHex(8))
	if err := os.MkdirAll(tempRoot, 0o700); err != nil {
		logf("FATAL: cannot create temp root: %v", err)
		os.Exit(1)
	}

	// Crash recovery: clean up any leftover session artifacts from a prior crash
	session.CrashRecovery(tempRoot)

	installPath, _ := os.Executable()
	prevExists := update.PrevBinaryExists(installPath)

	// Initialize subsystems
	actionMachine := action.New()
	sessionMgr := session.NewManager(tempRoot)
	execMgr := exec.NewManager(tempRoot)

	// Graceful shutdown
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
		<-sig
		cancel()
	}()

	// Current settings (updated in-place from beacon responses)
	currentSettings := beacon.Settings{
		PollInterval:       60,
		UptermRelay:        "ssh.uptermd.dev:22",
		ManagerPrimaryURL:  DefaultManagerURL,
		ManagerFallbackURL: DefaultFallbackURL,
	}

	// Action dispatcher
	onAction := func(a beacon.PendingAction, settings beacon.Settings) {
		currentSettings = settings
		actionMachine.Add(a.ID, a.Type, a.Payload)
		// Acknowledge immediately
		go postAck(ctx, a.ID, serverID, settings, actionMachine)
		// Dispatch by type
		go dispatchAction(ctx, a, serverID, settings, sessionMgr, execMgr, actionMachine, installPath)
	}

	// Update handler
	onUpdate := func(u beacon.UpdateInfo) {
		if err := update.ApplyUpdate(u.DownloadURL, u.SHA256, u.Signature, installPath); err != nil {
			postError(ctx, serverID, nil, err.Error(), "update", currentSettings)
		}
	}

	// Start beacon loop (blocks until ctx cancelled)
	beacon.Loop(
		ctx,
		serverID,
		Version,
		runtime.GOARCH,
		currentSettings.ManagerPrimaryURL,
		currentSettings.ManagerFallbackURL,
		currentSettings.PollInterval,
		actionMachine.PendingAcks,
		func() bool { return prevExists },
		onAction,
		onUpdate,
	)

	// Clean shutdown
	sessionMgr.KillAll()
	_ = os.RemoveAll(tempRoot)
}

// ─── Action dispatcher ────────────────────────────────────────────────────────

func dispatchAction(
	ctx context.Context,
	a beacon.PendingAction,
	serverID string,
	settings beacon.Settings,
	sessionMgr *session.Manager,
	execMgr *exec.Manager,
	machine *action.Machine,
	installPath string,
) {
	var (
		resultData  map[string]interface{}
		finalStatus = "completed"
	)

	switch a.Type {
	case "create_session":
		// Extract embedded binaries (arch-appropriate, injected by embed package)
		tmuxData := getEmbeddedTmux()
		uptermData := getEmbeddedUpterm()

		sess, err := sessionMgr.Create(
			ctx,
			a.ID,
			serverID,
			settings.AuthorizedKeys,
			settings.UptermRelay,
			tmuxData,
			uptermData,
		)
		if err != nil {
			finalStatus = "failed"
			resultData = map[string]interface{}{"error": err.Error()}
		} else {
			resultData = map[string]interface{}{"session_link": sess.SSHLink}
		}

	case "kill_session":
		sid := stringField(a.Payload, "session_id")
		if err := sessionMgr.Kill(sid); err != nil {
			finalStatus = "failed"
			resultData = map[string]interface{}{"error": err.Error()}
		} else {
			resultData = map[string]interface{}{}
		}

	case "execute_cmd":
		cmdStr := stringField(a.Payload, "cmd")
		timeout := intField(a.Payload, "timeout")
		tmuxBin := getEmbeddedTmuxPath(sessionMgr) // reuse extracted tmux if a session is active

		_ = machine.Transition(a.ID, action.StatusRunning)

		cmd, err := execMgr.Execute(a.ID, serverID, cmdStr, timeout, tmuxBin, func(c *exec.Command) {
			c.Mu().Lock()
			output := c.Output
			exitCode := c.ExitCode
			errStr := c.Error
			c.Mu().Unlock()

			status := "completed"
			if errStr == "timed_out" {
				status = "timed_out"
			} else if errStr != "" {
				status = "failed"
			}

			postResult(ctx, a.ID, serverID, status, map[string]interface{}{
				"output":    output,
				"exit_code": exitCode,
				"error":     errStr,
			}, settings, machine)
		})
		if err != nil {
			postResult(ctx, a.ID, serverID, "failed", map[string]interface{}{"error": err.Error()}, settings, machine)
		}
		_ = cmd
		return // result posted by callback

	case "stop_cmd":
		targetActionID := stringField(a.Payload, "action_id")
		cmd, ok := execMgr.Stop(targetActionID)
		if !ok {
			finalStatus = "failed"
			resultData = map[string]interface{}{"error": "command not found or already stopped"}
		} else {
			_ = cmd
			resultData = map[string]interface{}{}
		}

	case "get_cmd_output":
		targetActionID := stringField(a.Payload, "action_id")
		output, ok := execMgr.GetOutput(targetActionID)
		if !ok {
			finalStatus = "failed"
			resultData = map[string]interface{}{"error": "command not found"}
		} else {
			resultData = map[string]interface{}{"output": output}
		}

	case "update_client":
		if boolField(a.Payload, "cleanup_prev") {
			if err := update.CleanupPrev(installPath); err != nil {
				finalStatus = "failed"
				resultData = map[string]interface{}{"error": err.Error()}
			} else {
				resultData = map[string]interface{}{}
			}
		} else {
			// Handled separately by onUpdate callback — should not arrive here
			return
		}

	default:
		finalStatus = "failed"
		resultData = map[string]interface{}{"error": fmt.Sprintf("unknown action type: %s", a.Type)}
	}

	postResult(ctx, a.ID, serverID, finalStatus, resultData, settings, machine)
}

// ─── Immediate POST helpers ───────────────────────────────────────────────────

func postAck(ctx context.Context, actionID, serverID string, settings beacon.Settings, machine *action.Machine) {
	body := map[string]interface{}{"server_id": serverID}
	path := "/api/client/actions/" + actionID + "/ack"
	resp, err := beacon.PostJSON(ctx, settings.ManagerPrimaryURL, settings.ManagerFallbackURL, path, body)
	if err != nil || resp.StatusCode != 200 {
		machine.MarkNeedsResync(actionID)
		return
	}
	resp.Body.Close()
	_ = machine.Transition(actionID, action.StatusAcked)
}

func postResult(
	ctx context.Context,
	actionID, serverID, finalStatus string,
	result map[string]interface{},
	settings beacon.Settings,
	machine *action.Machine,
) {
	body := map[string]interface{}{
		"server_id":    serverID,
		"result":       result,
		"final_status": finalStatus,
	}
	path := "/api/client/actions/" + actionID + "/result"
	resp, err := beacon.PostJSON(ctx, settings.ManagerPrimaryURL, settings.ManagerFallbackURL, path, body)
	if err != nil || resp.StatusCode != 200 {
		machine.MarkNeedsResync(actionID)
		return
	}
	resp.Body.Close()
	machine.Remove(actionID)
}

func postError(ctx context.Context, serverID string, actionID *string, errMsg, context_ string, settings beacon.Settings) {
	body := map[string]interface{}{
		"server_id": serverID,
		"action_id": actionID,
		"error":     errMsg,
		"context":   context_,
	}
	_, _ = beacon.PostJSON(ctx, settings.ManagerPrimaryURL, settings.ManagerFallbackURL, "/api/client/error", body)
}

func getEmbeddedTmuxPath(_ *session.Manager) string {
	// Commands always get a fresh tmux extraction via exec's own temp dir.
	// Return empty to let exec package fall back to PATH tmux.
	return ""
}

// ─── Field helpers ────────────────────────────────────────────────────────────

func stringField(m map[string]interface{}, key string) string {
	v, _ := m[key].(string)
	return v
}

func intField(m map[string]interface{}, key string) int {
	switch v := m[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	}
	return 0
}

func boolField(m map[string]interface{}, key string) bool {
	v, _ := m[key].(bool)
	return v
}

// logf is the only logging function in the codebase.
// In release builds (//go:build release), this is a no-op.
func logf(format string, args ...interface{}) {
	debugLog(format, args...)
}

// Ensure fmt is used
var _ = fmt.Sprintf
