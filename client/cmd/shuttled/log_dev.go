//go:build !release

package main

import (
	"fmt"
	"time"
)

// debugLog prints to stderr in dev/test builds.
// In release builds (//go:build release), this file is excluded and
// debugLog resolves to the no-op in log_release.go.
func debugLog(format string, args ...interface{}) {
	ts := time.Now().Format("2006-01-02T15:04:05Z07:00")
	fmt.Fprintf(errorWriter(), "[%s] "+format+"\n", append([]interface{}{ts}, args...)...)
}
