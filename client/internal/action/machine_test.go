package action

import (
	"testing"
)

func TestMachine_AddAndGet(t *testing.T) {
	m := New()
	m.Add("abc", "create_session", map[string]interface{}{"relay": "ssh.uptermd.dev"})

	a := m.Get("abc")
	if a == nil {
		t.Fatal("expected action, got nil")
	}
	if a.Status != StatusDelivered {
		t.Errorf("expected Delivered, got %s", a.Status)
	}
}

func TestMachine_ValidTransitions(t *testing.T) {
	cases := []struct {
		from Status
		to   Status
		ok   bool
	}{
		{StatusDelivered, StatusAcked, true},
		{StatusAcked, StatusRunning, true},
		{StatusRunning, StatusCompleted, true},
		{StatusRunning, StatusFailed, true},
		{StatusRunning, StatusTimedOut, true},
		{StatusRunning, StatusStopped, true},
		{StatusAcked, StatusCompleted, true},  // short-circuit for instant ops
		{StatusDelivered, StatusRunning, false}, // skip ack
		{StatusCompleted, StatusRunning, false}, // can't go back
		{StatusFailed, StatusCompleted, false},
	}

	for _, tc := range cases {
		m := New()
		m.Add("x", "execute_cmd", nil)
		// Force the starting state
		m.mu.Lock()
		m.actions["x"].Status = tc.from
		m.mu.Unlock()

		err := m.Transition("x", tc.to)
		if tc.ok && err != nil {
			t.Errorf("transition %s→%s: expected ok, got err: %v", tc.from, tc.to, err)
		}
		if !tc.ok && err == nil {
			t.Errorf("transition %s→%s: expected error, got nil", tc.from, tc.to)
		}
	}
}

func TestMachine_NotFound(t *testing.T) {
	m := New()
	err := m.Transition("nonexistent", StatusAcked)
	if err == nil {
		t.Error("expected error for unknown action ID")
	}
}

func TestMachine_PendingAcks(t *testing.T) {
	m := New()
	m.Add("a1", "create_session", nil)
	m.Add("a2", "execute_cmd", nil)
	m.MarkNeedsResync("a1")

	ids := m.PendingAcks()
	if len(ids) != 1 || ids[0] != "a1" {
		t.Errorf("expected [a1], got %v", ids)
	}
}

func TestMachine_Remove(t *testing.T) {
	m := New()
	m.Add("z", "kill_session", nil)
	m.Remove("z")
	if m.Get("z") != nil {
		t.Error("action should have been removed")
	}
}

func TestMachine_ConcurrentAccess(t *testing.T) {
	m := New()
	done := make(chan struct{})
	for i := 0; i < 50; i++ {
		go func(n int) {
			id := "act"
			m.Add(id, "execute_cmd", nil)
			_ = m.Get(id)
			m.MarkNeedsResync(id)
			_ = m.PendingAcks()
			done <- struct{}{}
		}(i)
	}
	for i := 0; i < 50; i++ {
		<-done
	}
}
