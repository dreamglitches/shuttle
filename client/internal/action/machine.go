// Package action implements the client-side action state machine.
// States: pending → delivered → acked → running → completed|failed|timed_out|stopped
package action

import (
	"fmt"
	"sync"
	"time"
)

// Status mirrors the manager's action status enum.
type Status string

const (
	StatusPending   Status = "pending"
	StatusDelivered Status = "delivered"
	StatusAcked     Status = "acked"
	StatusRunning   Status = "running"
	StatusCompleted Status = "completed"
	StatusFailed    Status = "failed"
	StatusTimedOut  Status = "timed_out"
	StatusStopped   Status = "stopped"
)

// Action represents a single in-flight action on the client side.
type Action struct {
	ID          string
	Type        string
	Payload     map[string]interface{}
	Status      Status
	UpdatedAt   time.Time
	NeedsResync bool // true if immediate-POST ack/result failed and needs retry via beacon
}

// Machine manages all in-flight actions with safe concurrent access.
type Machine struct {
	mu      sync.Mutex
	actions map[string]*Action
}

// New creates a new action state machine.
func New() *Machine {
	return &Machine{actions: make(map[string]*Action)}
}

// Add registers a newly received action as delivered.
func (m *Machine) Add(id, actionType string, payload map[string]interface{}) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.actions[id] = &Action{
		ID:        id,
		Type:      actionType,
		Payload:   payload,
		Status:    StatusDelivered,
		UpdatedAt: time.Now(),
	}
}

// Transition moves an action to the next status. Returns an error if the
// transition is not valid from the current state.
func (m *Machine) Transition(id string, next Status) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	a, ok := m.actions[id]
	if !ok {
		return fmt.Errorf("action %s not found", id)
	}

	if !validTransition(a.Status, next) {
		return fmt.Errorf("invalid transition %s → %s for action %s", a.Status, next, id)
	}

	a.Status = next
	a.UpdatedAt = time.Now()
	return nil
}

// Get returns a copy of the action, or nil if not found.
func (m *Machine) Get(id string) *Action {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.actions[id]
	if !ok {
		return nil
	}
	cp := *a
	return &cp
}

// MarkNeedsResync flags an action for retry delivery in the next beacon.
// Called when an immediate POST for ack/result fails.
func (m *Machine) MarkNeedsResync(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if a, ok := m.actions[id]; ok {
		a.NeedsResync = true
	}
}

// PendingAcks returns IDs of actions that need to be re-confirmed via the
// next beacon's ack_action_ids field (because their immediate POST failed).
func (m *Machine) PendingAcks() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var ids []string
	for _, a := range m.actions {
		if a.NeedsResync {
			ids = append(ids, a.ID)
		}
	}
	return ids
}

// Remove deletes a completed/failed/stopped action from memory.
// Called after successful result delivery to keep memory bounded.
func (m *Machine) Remove(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.actions, id)
}

// All returns copies of all current actions (for introspection/logging).
func (m *Machine) All() []Action {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Action, 0, len(m.actions))
	for _, a := range m.actions {
		out = append(out, *a)
	}
	return out
}

// validTransition returns true if moving from → to is a legal state change.
func validTransition(from, to Status) bool {
	allowed := map[Status][]Status{
		StatusDelivered: {StatusAcked},
		StatusAcked:     {StatusRunning, StatusCompleted, StatusFailed},
		StatusRunning:   {StatusCompleted, StatusFailed, StatusTimedOut, StatusStopped},
		// Allow re-delivery ack if a prior ack was lost
		StatusPending: {StatusDelivered, StatusAcked},
	}
	for _, s := range allowed[from] {
		if s == to {
			return true
		}
	}
	return false
}
