#!/usr/bin/env bash
# Installs the latest tidy release binary to ~/.local/bin/tidy, or under a
# name you pick when a tidy command already exists.
# Never asks for a password. Override the target directory with INSTALL_DIR.
set -euo pipefail

REPO="framwrk/Tidy"
BINARY="tidy-macos-arm64"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
RECORDS="$HOME/Library/Application Support/Tidy"

# macOS on Apple Silicon only, matching the compiled binary.
[ "$(uname -s)" = "Darwin" ] || { echo "tidy supports macOS only." >&2; exit 1; }
[ "$(uname -m)" = "arm64" ] || { echo "tidy supports Apple Silicon only." >&2; exit 1; }

# A pre-existing tidy command (macOS ships HTML tidy at /usr/bin/tidy) gets
# asked about: keep this install ahead of it in PATH, or pick another name.
# The answer comes from /dev/tty so a 'curl | bash' stdin stays untouched.
EXISTING="$(command -v tidy || true)"
NAME="tidy"
if [ -n "$EXISTING" ] && [ "$EXISTING" != "$INSTALL_DIR/tidy" ]; then
  if { true < /dev/tty; } 2>/dev/null; then
    echo "A 'tidy' command already exists: $EXISTING"
    echo "This install can take priority in your PATH, or use another name:"
    echo "  1) tidy     - take priority over the existing one"
    echo "  2) tidyup"
    echo "  3) tdy"
    echo "  4) tidy-cli"
    echo "  5) tidytool"
    printf "Choose [1]: "
    read -r CHOICE < /dev/tty || CHOICE=""
    case "${CHOICE:-1}" in
      2) NAME="tidyup" ;;
      3) NAME="tdy" ;;
      4) NAME="tidy-cli" ;;
      5) NAME="tidytool" ;;
    esac
  else
    echo "Note: a 'tidy' command already exists at $EXISTING - this install takes priority only where $INSTALL_DIR comes first in your PATH."
  fi
fi
DEST="$INSTALL_DIR/$NAME"

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

# Record the installed name so uninstall.sh finds the binary whatever it is.
mkdir -p "$RECORDS"
echo "$NAME" > "$RECORDS/binary-name"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Note: $INSTALL_DIR is not on your PATH - add it to your shell profile." ;;
esac

echo "$NAME installed to $DEST - run '$NAME' to start."
