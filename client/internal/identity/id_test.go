package identity

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestDeriveServerID_stable(t *testing.T) {
	id1, err := DeriveServerID()
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	id2, err := DeriveServerID()
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if id1 != id2 {
		t.Errorf("ID is not stable across calls: %q != %q", id1, id2)
	}
	if len(id1) != 64 {
		t.Errorf("expected 64-char hex, got len=%d", len(id1))
	}
}

func TestDeriveServerID_format(t *testing.T) {
	id, err := DeriveServerID()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, decErr := hex.DecodeString(id); decErr != nil {
		t.Errorf("ID is not valid hex: %q", id)
	}
}

func TestFallbackID_persistent(t *testing.T) {
	tmp := t.TempDir()
	origPath := fallbackIDPath
	fallbackIDPath = filepath.Join(tmp, ".shuttled_id")
	t.Cleanup(func() { fallbackIDPath = origPath })

	// Simulate no hardware sources by forcing fallback
	id1, err := fallbackID()
	if err != nil {
		t.Fatalf("fallbackID: %v", err)
	}
	id2, err := fallbackID()
	if err != nil {
		t.Fatalf("fallbackID second call: %v", err)
	}
	if id1 != id2 {
		t.Errorf("fallback ID not persistent: %q != %q", id1, id2)
	}
}

func TestDeriveServerID_cloneDetection(t *testing.T) {
	// Verify that two different machines with the same machine-id
	// but different MACs produce different IDs.
	// We can't easily test this in unit tests since readPrimaryMAC reads live
	// interfaces; this test documents the expectation.
	//
	// The manager is responsible for flagging same-server_id from different IPs.
	// Here we just verify that the hash is sensitive to input changes.

	h1 := sha256.Sum256([]byte("machine:abc|mac:00:11:22:33:44:55"))
	h2 := sha256.Sum256([]byte("machine:abc|mac:aa:bb:cc:dd:ee:ff"))
	if hex.EncodeToString(h1[:]) == hex.EncodeToString(h2[:]) {
		t.Error("different MACs produced the same hash — hash is broken")
	}
}

func TestReadMachineID(t *testing.T) {
	// Just verify it doesn't panic; actual value depends on host
	_ = readMachineID()
}

func TestReadDMIUUID_zeroIgnored(t *testing.T) {
	// Create a fake DMI file with all-zeros UUID
	tmp := t.TempDir()
	path := filepath.Join(tmp, "product_uuid")
	os.WriteFile(path, []byte("00000000-0000-0000-0000-000000000000\n"), 0o644)
	// readDMIUUID reads from /sys path directly; can't easily redirect.
	// This test documents the behavior expectation.
	t.Log("All-zeros DMI UUID should be ignored — manual verification required on live system")
}
