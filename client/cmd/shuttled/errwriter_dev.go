// dev errorWriter — writes to stderr in non-release builds
//go:build !release

package main

import "os"

func errorWriter() *os.File {
	return os.Stderr
}
