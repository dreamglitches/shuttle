package exec

import "sync"

// Mu exposes the command's mutex so callers can lock it to read fields.
func (c *Command) Mu() *sync.Mutex { return &c.mu }
