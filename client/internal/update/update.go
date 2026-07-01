// Package update implements atomic self-update with ed25519 signature verification
// and crash-loop rollback. The ed25519 public key is compiled into the binary.
package update

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// ApplyUpdate downloads, verifies, and atomically installs an update.
// On success the process exits cleanly (systemd restarts it with the new binary).
// On failure the existing binary is untouched.
func ApplyUpdate(downloadURL, sha256Hex, signatureB64, installPath string) error {
	// 1. Download to a temp file on the same filesystem
	tmpPath := installPath + ".new"
	if err := download(downloadURL, tmpPath); err != nil {
		return fmt.Errorf("update: download: %w", err)
	}

	defer func() {
		// Clean up .new if we didn't commit
		if _, err := os.Stat(tmpPath); err == nil {
			_ = os.Remove(tmpPath)
		}
	}()

	// 2. Read downloaded bytes
	data, err := os.ReadFile(tmpPath)
	if err != nil {
		return fmt.Errorf("update: read download: %w", err)
	}

	// 3. Verify SHA-256 checksum
	hash := sha256.Sum256(data)
	gotHex := hex.EncodeToString(hash[:])
	if gotHex != sha256Hex {
		return fmt.Errorf("update: checksum mismatch: got %s want %s", gotHex, sha256Hex)
	}

	// 4. Verify ed25519 signature (message = sha256 hex string)
	sigBytes, err := base64.StdEncoding.DecodeString(signatureB64)
	if err != nil {
		return fmt.Errorf("update: decode signature: %w", err)
	}
	if !ed25519.Verify(UpdatePublicKey, []byte(sha256Hex), sigBytes) {
		return fmt.Errorf("update: signature verification failed — rejecting update")
	}

	// 5. Chmod the new binary
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		return fmt.Errorf("update: chmod: %w", err)
	}

	// 6. Rename current binary to .prev (atomic on same filesystem)
	prevPath := installPath + ".prev"
	if err := os.Rename(installPath, prevPath); err != nil {
		return fmt.Errorf("update: backup current binary: %w", err)
	}

	// 7. Rename .new to install path (atomic swap)
	if err := os.Rename(tmpPath, installPath); err != nil {
		// Try to restore backup
		_ = os.Rename(prevPath, installPath)
		return fmt.Errorf("update: install new binary: %w", err)
	}

	// 8. Exit cleanly — systemd restarts with the new binary
	// The new binary will POST a beacon; once that succeeds, the manager sends
	// a cleanup_prev action and .prev is deleted.
	os.Exit(0)
	return nil // unreachable
}

// CleanupPrev removes the .prev backup if it exists.
// Called only after the manager confirms the new binary is healthy
// (one successful beacon cycle post-update).
func CleanupPrev(installPath string) error {
	prevPath := installPath + ".prev"
	if _, err := os.Stat(prevPath); os.IsNotExist(err) {
		return nil // already gone
	}
	if err := os.Remove(prevPath); err != nil {
		return fmt.Errorf("update: cleanup .prev: %w", err)
	}
	return nil
}

// PrevBinaryExists returns true if a .prev backup exists at the install path.
func PrevBinaryExists(installPath string) bool {
	_, err := os.Stat(installPath + ".prev")
	return err == nil
}

// RollbackCheck is called via --rollback-check flag (ExecStopPost in systemd unit).
// If .prev exists and we're in a crash-loop (systemd restart counter exceeded),
// it swaps .prev back over the current binary and exits 0.
//
// Detection: the binary looks for a crash counter env var set by the unit file,
// or simply swaps if .prev exists and is newer than the main binary.
func RollbackCheck(installPath string) {
	prevPath := installPath + ".prev"
	if _, err := os.Stat(prevPath); os.IsNotExist(err) {
		return // nothing to roll back
	}

	mainStat, err := os.Stat(installPath)
	if err != nil {
		return
	}
	prevStat, err := os.Stat(prevPath)
	if err != nil {
		return
	}

	// If .prev is older (the expected case after a successful update), don't rollback
	// unless SHUTTLE_ROLLBACK=1 is set (by ExecStopPost script detecting crash-loop).
	forceRollback := os.Getenv("SHUTTLE_ROLLBACK") == "1"
	if !forceRollback {
		// Heuristic: if main was modified more recently than prev, assume it's new
		if mainStat.ModTime().After(prevStat.ModTime()) {
			// Only rollback if we've been running for less than 30s
			// (crash right after update)
			if time.Since(mainStat.ModTime()) > 30*time.Second {
				return
			}
		}
	}

	// Swap: rename .prev back over the current binary
	if err := os.Rename(prevPath, installPath); err != nil {
		os.Exit(1) // can't rollback — catastrophic
	}
	// Exit 0 — systemd will restart with the restored binary
	os.Exit(0)
}

// ─── Download helper ──────────────────────────────────────────────────────────

func download(url, dest string) error {
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Get(url) //nolint:gosec // URL comes from manager, signed update
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("server returned %d", resp.StatusCode)
	}

	f, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()

	_, err = io.Copy(f, resp.Body)
	return err
}
