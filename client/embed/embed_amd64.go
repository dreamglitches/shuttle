//go:build amd64 && linux

package embed

import (
	_ "embed"
)

//go:embed amd64/tmux.gz
var tmuxGz []byte

//go:embed amd64/upterm.gz
var uptermGz []byte

// Tmux returns the compressed tmux binary for linux/amd64.
func Tmux() []byte { return tmuxGz }

// Upterm returns the compressed upterm binary for linux/amd64.
func Upterm() []byte { return uptermGz }
