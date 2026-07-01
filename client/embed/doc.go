// Package embed provides the embedded tmux and upterm binaries for this build.
// Each arch has its own file with a build tag. The binaries are stored compressed
// (gzip) to reduce binary size; they are decompressed on first extraction.
//
// To populate the embed dirs, run:
//   make embed
// which downloads the appropriate static binaries and places them under:
//   embed/amd64/tmux.gz   embed/amd64/upterm.gz
//   embed/arm64/tmux.gz   embed/arm64/upterm.gz
//   embed/386/tmux.gz     embed/386/upterm.gz
package embed
