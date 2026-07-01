# Shuttle — Build Makefile
# Usage:
#   make embed                  Download and gzip tmux+upterm binaries into embed dirs
#   make build PSK=<value>      Build release binaries for all arches
#   make build-dev              Build dev binary for host arch (with logging)
#   make test                   Run all client unit tests

PSK         ?= CHANGEME
VERSION     ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
MODULE      := github.com/shuttle-fleet/shuttle/client
LDFLAGS     := -s -w -X $(MODULE)/internal/auth.PSK=$(PSK) -X main.Version=$(VERSION)
LDFLAGS_DEV := -X $(MODULE)/internal/auth.PSK=$(PSK) -X main.Version=$(VERSION)-dev

# Upterm + tmux versions to embed
UPTERM_VERSION := 0.13.0
TMUX_VERSION   := 3.4

.PHONY: all embed build build-dev test clean

all: embed build

# ─── Download & compress embedded binaries ────────────────────────────────────
embed: embed/amd64/.done embed/arm64/.done embed/386/.done

embed/amd64/.done:
	@mkdir -p embed/amd64
	@echo "Downloading tmux amd64..."
	curl -fsSL "https://github.com/nicowillis/tmux-static/releases/download/$(TMUX_VERSION)/tmux-$(TMUX_VERSION)-x86_64" -o embed/amd64/tmux
	@echo "Downloading upterm amd64..."
	curl -fsSL "https://github.com/owenthereal/upterm/releases/download/v$(UPTERM_VERSION)/upterm_linux_amd64.tar.gz" | tar -xz -C embed/amd64/ upterm
	gzip -f embed/amd64/tmux
	gzip -f embed/amd64/upterm
	@touch embed/amd64/.done

embed/arm64/.done:
	@mkdir -p embed/arm64
	@echo "Downloading tmux arm64..."
	curl -fsSL "https://github.com/nicowillis/tmux-static/releases/download/$(TMUX_VERSION)/tmux-$(TMUX_VERSION)-aarch64" -o embed/arm64/tmux
	@echo "Downloading upterm arm64..."
	curl -fsSL "https://github.com/owenthereal/upterm/releases/download/v$(UPTERM_VERSION)/upterm_linux_arm64.tar.gz" | tar -xz -C embed/arm64/ upterm
	gzip -f embed/arm64/tmux
	gzip -f embed/arm64/upterm
	@touch embed/arm64/.done

embed/386/.done:
	@mkdir -p embed/386
	@echo "Downloading tmux 386..."
	curl -fsSL "https://github.com/nicowillis/tmux-static/releases/download/$(TMUX_VERSION)/tmux-$(TMUX_VERSION)-i686" -o embed/386/tmux
	@echo "Downloading upterm 386..."
	curl -fsSL "https://github.com/owenthereal/upterm/releases/download/v$(UPTERM_VERSION)/upterm_linux_386.tar.gz" | tar -xz -C embed/386/ upterm
	gzip -f embed/386/tmux
	gzip -f embed/386/upterm
	@touch embed/386/.done

# ─── Release builds ───────────────────────────────────────────────────────────
build: dist/shuttled-linux-amd64 dist/shuttled-linux-arm64 dist/shuttled-linux-386

dist/shuttled-linux-amd64:
	@mkdir -p dist
	GOOS=linux GOARCH=amd64 go build -tags release \
	  -ldflags "$(LDFLAGS)" \
	  -o dist/shuttled-linux-amd64 ./cmd/shuttled
	@echo "Built dist/shuttled-linux-amd64 ($(shell du -h dist/shuttled-linux-amd64 | cut -f1))"

dist/shuttled-linux-arm64:
	@mkdir -p dist
	GOOS=linux GOARCH=arm64 go build -tags release \
	  -ldflags "$(LDFLAGS)" \
	  -o dist/shuttled-linux-arm64 ./cmd/shuttled
	@echo "Built dist/shuttled-linux-arm64 ($(shell du -h dist/shuttled-linux-arm64 | cut -f1))"

dist/shuttled-linux-386:
	@mkdir -p dist
	GOOS=linux GOARCH=386 go build -tags release \
	  -ldflags "$(LDFLAGS)" \
	  -o dist/shuttled-linux-386 ./cmd/shuttled
	@echo "Built dist/shuttled-linux-386 ($(shell du -h dist/shuttled-linux-386 | cut -f1))"

# ─── Dev build (with logging, no release tag) ─────────────────────────────────
build-dev:
	go build -ldflags "$(LDFLAGS_DEV)" -o dist/shuttled-dev ./cmd/shuttled
	@echo "Dev build: dist/shuttled-dev"

# ─── Tests ────────────────────────────────────────────────────────────────────
test:
	go test ./... -count=1 -race -timeout 60s

test-release:
	go test -tags release ./... -count=1 -timeout 60s

# Verify release build has zero logging output (grep for fmt.Print* in binary strings)
test-no-log:
	@echo "Checking release binary for logging fingerprints..."
	@if strings dist/shuttled-linux-amd64 | grep -qE 'fmt\.(Print|Sprint|Fprintf)|log\.'; then \
	  echo "FAIL: logging strings found in release binary"; exit 1; \
	else echo "OK: no logging fingerprint found"; fi

clean:
	rm -rf dist/ embed/amd64/.done embed/arm64/.done embed/386/.done
