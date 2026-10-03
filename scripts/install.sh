#!/usr/bin/env bash
# Installs the latest tidy release binary to /usr/local/bin/tidy.
# Override the target directory with INSTALL_DIR.
set -euo pipefail

REPO="framwrk/Tidy"
BINARY="tidy-macos-arm64"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
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

# Install directly if possible, otherwise fall back to sudo.
mkdir -p "$INSTALL_DIR"
if [ -w "$INSTALL_DIR" ]; then
  install -m 755 "$TMP/$BINARY" "$DEST"
else
  sudo install -m 755 "$TMP/$BINARY" "$DEST"
fi

echo "tidy installed to $DEST - run 'tidy' to start."