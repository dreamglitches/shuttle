// Package auth provides PSK-based HMAC-SHA256 request signing for the shuttled client.
// The PSK is injected at build time via:
//
//	go build -ldflags "-X github.com/shuttle-fleet/shuttle/client/internal/auth.PSK=<value>"
//
// Never printed, logged, or written to disk. Zero fingerprint.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// PSK is the fleet pre-shared key, injected at link time.
// It is intentionally a package-level var (not const) so the linker can set it.
var PSK string

// SignRequest adds HMAC-SHA256 authentication headers to an outbound request.
// The signature covers: METHOD\nPATH\nTIMESTAMP\nHEX(SHA256(body)).
// Returns an error if PSK is not set.
func SignRequest(method, path string, body []byte) (http.Header, error) {
	if PSK == "" {
		return nil, fmt.Errorf("PSK not set — rebuild with -ldflags \"-X .../auth.PSK=<value>\"")
	}

	ts := strconv.FormatInt(time.Now().Unix(), 10)

	// Hash the body
	bodyHash := sha256.Sum256(body)
	bodyHex := hex.EncodeToString(bodyHash[:])

	// Build message to sign
	message := method + "\n" + path + "\n" + ts + "\n" + bodyHex

	// HMAC-SHA256
	mac := hmac.New(sha256.New, []byte(PSK))
	mac.Write([]byte(message))
	sig := hex.EncodeToString(mac.Sum(nil))

	h := make(http.Header)
	h.Set("X-Shuttle-Timestamp", ts)
	h.Set("X-Shuttle-Signature", sig)
	h.Set("X-Shuttle-PSK", "1") // presence indicator only, not the key
	h.Set("Content-Type", "application/json")
	return h, nil
}
