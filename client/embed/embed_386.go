//go:build 386 && linux

package embed

import (
	_ "embed"
)

//go:embed 386/tmux.gz
var tmuxGz []byte

//go:embed 386/upterm.gz
var uptermGz []byte

// Tmux returns the compressed tmux binary for linux/386.
func Tmux() []byte { return tmuxGz }

// Upterm returns the compressed upterm binary for linux/386.
func Upterm() []byte { return uptermGz }
