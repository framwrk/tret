#!/usr/bin/env bash
# Installs the latest tidy release binary to ~/.local/bin/tidy.
# Never asks for a password. Override the target directory with INSTALL_DIR.
set -euo pipefail

REPO="framwrk/Tidy"
BINARY="tidy-macos-arm64"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
DEST="$INSTALL_DIR/tidy"

# macOS on Apple Silicon only, matching the compiled binary.
[ "$(uname -s)" = "Darwin" ] || { echo "tidy supports macOS only." >&2; exit 1; }
[ "$(uname -m)" = "arm64" ] || { echo "tidy supports Apple Silicon only." >&2; exit 1; }

# Scratch directory for the downloads; removed on exit.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Resolve the newest release tag from the API: the /releases/latest redirect
# skips pre-releases, and until 1.0 every tidy release is one.
TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases" | grep -m1 '"tag_name"' | cut -d'"' -f4)"
BASE="https://github.com/$REPO/releases/download/$TAG"
curl -fsSL "$BASE/$BINARY" -o "$TMP/$BINARY"
curl -fsSL "$BASE/checksums.txt" -o "$TMP/checksums.txt"

# Fail closed on a missing checksum entry or a corrupted download.
(cd "$TMP" && grep " $BINARY\$" checksums.txt | shasum -a 256 -c -)

# Install without sudo: the default target is user-writable. An existing
# INSTALL_DIR that is not writable fails instead of falling back to sudo.
if [ -d "$INSTALL_DIR" ] && [ ! -w "$INSTALL_DIR" ]; then
  echo "$INSTALL_DIR is not writable - set INSTALL_DIR to a directory you own." >&2
  exit 1
fi
mkdir -p "$INSTALL_DIR"
install -m 755 "$TMP/$BINARY" "$DEST"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Note: $INSTALL_DIR is not on your PATH - add it to your shell profile." ;;
esac

echo "tidy installed to $DEST - run 'tidy' to start."
