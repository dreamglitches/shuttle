//go:build release

package main

import "os"

// debugLog is a no-op in release builds.
// No output of any kind reaches stdout/stderr.
// All diagnostics go to the manager's error endpoint.
func debugLog(_ string, _ ...interface{}) {}

// errorWriter returns /dev/null in release builds — no stderr output.
func errorWriter() *os.File {
	f, _ := os.Open(os.DevNull)
	return f
}
