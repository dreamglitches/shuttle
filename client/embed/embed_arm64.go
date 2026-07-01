//go:build arm64 && linux

package embed

import (
	_ "embed"
)

//go:embed arm64/tmux.gz
var tmuxGz []byte

//go:embed arm64/upterm.gz
var uptermGz []byte

// Tmux returns the compressed tmux binary for linux/arm64.
func Tmux() []byte { return tmuxGz }

// Upterm returns the compressed upterm binary for linux/arm64.
func Upterm() []byte { return uptermGz }
