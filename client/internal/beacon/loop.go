// Package beacon implements the polling loop that drives all client-manager communication.
package beacon

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/dreamglitches/shuttle/client/internal/auth"
)

// Settings received from the manager, propagated without restart.
type Settings struct {
	PollInterval       int    `json:"poll_interval"`
	UptermRelay        string `json:"upterm_relay"`
	AuthorizedKeys     string `json:"authorized_keys"`
	OutputCapKB        int    `json:"output_cap_kb"`
	RetentionDays      int    `json:"retention_days"`
	ManagerPrimaryURL  string `json:"manager_primary_url"`
	ManagerFallbackURL string `json:"manager_fallback_url"`
}

// PendingAction is an action delivered by the manager in a beacon response.
type PendingAction struct {
	ID      string                 `json:"id"`
	Type    string                 `json:"type"`
	Payload map[string]interface{} `json:"payload"`
}

// BeaconRequest is the payload sent to the manager on each poll.
type BeaconRequest struct {
	ServerID         string   `json:"server_id"`
	ClientVersion    string   `json:"client_version"`
	Arch             string   `json:"arch"`
	AckActionIDs     []string `json:"ack_action_ids"`
	PrevBinaryExists bool     `json:"prev_binary_exists,omitempty"`
}

// BeaconResponse is the decoded manager response.
type BeaconResponse struct {
	Settings       Settings        `json:"settings"`
	PendingActions []PendingAction `json:"pending_actions"`
	Update         *UpdateInfo     `json:"update"`
}

// UpdateInfo carries a signed client update from the manager.
type UpdateInfo struct {
	Version     string `json:"version"`
	DownloadURL string `json:"download_url"`
	SHA256      string `json:"sha256"`
	Signature   string `json:"signature"`
}

// ActionCallback is called for each pending action received in a beacon response.
type ActionCallback func(action PendingAction, settings Settings)

// Loop runs the beacon polling loop until ctx is cancelled.
// It calls onAction for each pending action and applies settings updates in-place.
func Loop(
	ctx context.Context,
	serverID string,
	clientVersion string,
	arch string,
	primaryURL string,
	fallbackURL string,
	initialInterval int,
	pendingAcks func() []string,
	prevBinaryExists func() bool,
	onAction ActionCallback,
	onUpdate func(UpdateInfo),
) {
	interval := atomic.Int64{}
	interval.Store(int64(initialInterval))

	backoffCount := 0
	const maxBackoffS = 600 // 10 minutes

	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Duration(interval.Load()) * time.Second):
		}

		acks := pendingAcks()
		req := BeaconRequest{
			ServerID:         serverID,
			ClientVersion:    clientVersion,
			Arch:             arch,
			AckActionIDs:     acks,
			PrevBinaryExists: prevBinaryExists(),
		}

		resp, err := sendBeacon(ctx, primaryURL, fallbackURL, req)
		if err != nil {
			// Exponential backoff on network failure
			backoffCount++
			backoff := math.Min(float64(initialInterval)*math.Pow(2, float64(backoffCount-1)), float64(maxBackoffS))
			interval.Store(int64(backoff))
			continue
		}

		// Success — reset backoff, apply new interval from settings
		backoffCount = 0
		if resp.Settings.PollInterval > 0 {
			interval.Store(int64(resp.Settings.PollInterval))
		}

		// Dispatch actions
		for _, a := range resp.PendingActions {
			go onAction(a, resp.Settings)
		}

		// Handle update
		if resp.Update != nil && onUpdate != nil {
			go onUpdate(*resp.Update)
		}
	}
}

// PostJSON sends a signed JSON POST to the manager, trying primary then fallback URL.
func PostJSON(ctx context.Context, primaryURL, fallbackURL, path string, body interface{}) (*http.Response, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal: %w", err)
	}

	for _, base := range []string{primaryURL, fallbackURL} {
		if base == "" {
			continue
		}
		resp, err := doPost(ctx, base+path, data)
		if err == nil {
			return resp, nil
		}
	}
	return nil, fmt.Errorf("all manager URLs failed")
}

// ─── Internal ─────────────────────────────────────────────────────────────────

func sendBeacon(ctx context.Context, primaryURL, fallbackURL string, req BeaconRequest) (*BeaconResponse, error) {
	data, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}

	var resp *http.Response
	for _, base := range []string{primaryURL, fallbackURL} {
		if base == "" {
			continue
		}
		resp, err = doPost(ctx, base+"/api/client/beacon", data)
		if err == nil {
			break
		}
	}
	if err != nil {
		return nil, fmt.Errorf("beacon: all URLs failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("beacon: server returned %d: %s", resp.StatusCode, b)
	}

	var result BeaconResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("beacon: decode: %w", err)
	}
	return &result, nil
}

func doPost(ctx context.Context, url string, body []byte) (*http.Response, error) {
	headers, err := auth.SignRequest("POST", extractPath(url), body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for k, vs := range headers {
		for _, v := range vs {
			req.Header.Set(k, v)
		}
	}

	client := &http.Client{Timeout: 30 * time.Second}
	return client.Do(req)
}

func extractPath(rawURL string) string {
	// Fast path: find third slash
	count := 0
	for i, c := range rawURL {
		if c == '/' {
			count++
			if count == 3 {
				return rawURL[i:]
			}
		}
	}
	return "/"
}
