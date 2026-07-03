// Package main — binary decompression helper.
// Embedded binaries are gzip-compressed to reduce binary size.
// This file decompresses them on first access (lazy, cached).
package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"sync"

	embedded "github.com/dreamglitches/shuttle/client/embed"
)

var (
	tmuxOnce    sync.Once
	uptermOnce  sync.Once
	tmuxBytes   []byte
	uptermBytes []byte
)

func getEmbeddedTmux() []byte {
	tmuxOnce.Do(func() {
		tmuxBytes = mustDecompress(embedded.Tmux())
	})
	return tmuxBytes
}

func getEmbeddedUpterm() []byte {
	uptermOnce.Do(func() {
		uptermBytes = mustDecompress(embedded.Upterm())
	})
	return uptermBytes
}

func mustDecompress(gz []byte) []byte {
	r, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		// If not gzip (e.g., raw binary for testing), return as-is
		return gz
	}
	defer r.Close()
	data, err := io.ReadAll(r)
	if err != nil {
		return gz
	}
	return data
}
