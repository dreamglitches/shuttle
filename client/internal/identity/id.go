// Package identity derives a stable, unique server ID from hardware/OS sources.
// The ID is computed fresh at each startup — nothing is persisted (except as a
// last resort when no hardware sources are readable; see fallbackIDPath).
package identity

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
)

// fallbackIDPath is the one deliberate on-disk exception: written only when
// all hardware sources are unreadable (e.g., minimal containers).
var fallbackIDPath = filepath.Join(os.Getenv("HOME"), ".shuttled_id")

// DeriveServerID computes a stable server ID from:
//  1. /etc/machine-id (or /var/lib/dbus/machine-id)
//  2. Primary interface MAC address
//  3. /sys/class/dmi/id/product_uuid (SMBIOS UUID)
//
// Falls back to a persisted random ID if none of the above are readable.
func DeriveServerID() (string, error) {
	parts := []string{}

	if v := readMachineID(); v != "" {
		parts = append(parts, "machine:"+v)
	}
	if v := readPrimaryMAC(); v != "" {
		parts = append(parts, "mac:"+v)
	}
	if v := readDMIUUID(); v != "" {
		parts = append(parts, "dmi:"+v)
	}

	if len(parts) == 0 {
		// Last resort: persisted random ID
		return fallbackID()
	}

	combined := strings.Join(parts, "|")
	hash := sha256.Sum256([]byte(combined))
	return hex.EncodeToString(hash[:]), nil
}

// ─── Source readers ───────────────────────────────────────────────────────────

func readMachineID() string {
	for _, path := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		b, err := os.ReadFile(path)
		if err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	return ""
}

func readPrimaryMAC() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		// Skip loopback, virtual, and zero MACs
		if iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		mac := iface.HardwareAddr.String()
		if mac == "" || mac == "00:00:00:00:00:00" {
			continue
		}
		// Skip common virtual interface prefixes
		name := iface.Name
		if strings.HasPrefix(name, "veth") || strings.HasPrefix(name, "docker") ||
			strings.HasPrefix(name, "br-") || strings.HasPrefix(name, "virbr") {
			continue
		}
		return mac
	}
	return ""
}

func readDMIUUID() string {
	b, err := os.ReadFile("/sys/class/dmi/id/product_uuid")
	if err != nil {
		return ""
	}
	v := strings.TrimSpace(string(b))
	// Ignore all-zeros UUID (common in VMs without SMBIOS)
	if v == "00000000-0000-0000-0000-000000000000" {
		return ""
	}
	return v
}

// ─── Fallback: persisted random ID ───────────────────────────────────────────

func fallbackID() (string, error) {
	// Try to read existing fallback
	if b, err := os.ReadFile(fallbackIDPath); err == nil {
		id := strings.TrimSpace(string(b))
		if len(id) == 64 { // valid hex SHA-256
			return id, nil
		}
	}

	// Generate a new one
	raw := make([]byte, 32)
	if _, err := readRandom(raw); err != nil {
		return "", fmt.Errorf("identity: cannot generate fallback ID: %w", err)
	}
	hash := sha256.Sum256(raw)
	id := hex.EncodeToString(hash[:])

	// Persist it (best-effort; if this fails, every restart gets a new ID)
	_ = os.MkdirAll(filepath.Dir(fallbackIDPath), 0o700)
	_ = os.WriteFile(fallbackIDPath, []byte(id+"\n"), 0o600)
	return id, nil
}

func readRandom(b []byte) (int, error) {
	f, err := os.Open("/dev/urandom")
	if err != nil {
		return 0, err
	}
	defer f.Close()
	return f.Read(b)
}
