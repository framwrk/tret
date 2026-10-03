#!/usr/bin/env bash
# Installs the latest tret release binary to ~/.tret/bin/tret.
# Never asks for a password. Override the target directory with INSTALL_DIR.
set -euo pipefail

REPO="framwrk/tret"
BINARY="tret-macos-arm64"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.tret/bin}"
INSTALL_DIR="${INSTALL_DIR%/}"

# macOS on Apple Silicon only, matching the compiled binary.
[ "$(uname -s)" = "Darwin" ] || { echo "tret supports macOS only." >&2; exit 1; }
[ "$(uname -m)" = "arm64" ] || { echo "tret supports Apple Silicon only." >&2; exit 1; }

NAME="tret"
DEST="$INSTALL_DIR/$NAME"

# A pre-existing tret command outside our target is rare, but worth a note:
# the new binary only wins where $INSTALL_DIR comes first in your PATH.
# An already-installed target binary counts as ours: reinstalling it over
# itself needs no note.
EXISTING="$(command -v "$NAME" || true)"
if [ ! -x "$DEST" ] && [ -n "$EXISTING" ] && [ "$EXISTING" != "$DEST" ]; then
  echo "Note: a 'tret' command already exists at $EXISTING - this install takes priority only where $INSTALL_DIR comes first in your PATH."
fi

# Install without sudo: the default target is user-writable. An existing
# INSTALL_DIR that is not writable fails instead of falling back to sudo.
if [ -d "$INSTALL_DIR" ] && [ ! -w "$INSTALL_DIR" ]; then
  echo "$INSTALL_DIR is not writable - set INSTALL_DIR to a directory you own." >&2
  exit 1
fi
mkdir -p "$INSTALL_DIR" 2>/dev/null || {
  echo "$INSTALL_DIR could not be created - set INSTALL_DIR to a directory you own." >&2
  exit 1
}

# Scratch directory for the downloads; removed on exit. A partial $DEST.tmp
# from an interrupted install goes with it.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; rm -f "$DEST.tmp"' EXIT

# Resolve the newest release tag from the API: the /releases/latest redirect
# skips pre-releases, and until 1.0 every tret release is one.
# A 200 body with no tag (empty releases list, proxy error page) otherwise
# exits silently under pipefail, so validate the tag before using it.
TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases" | { grep -m1 '"tag_name"' || true; } | cut -d'"' -f4)" ||
  { echo "Could not read releases for $REPO from the GitHub API." >&2; exit 1; }
[ -n "$TAG" ] && [ "${TAG#v}" != "$TAG" ] || {
  echo "No release tag found for $REPO - is there a published release?" >&2
  exit 1
}
BASE="https://github.com/$REPO/releases/download/$TAG"
curl -fsSL "$BASE/$BINARY" -o "$TMP/$BINARY"
curl -fsSL "$BASE/checksums.txt" -o "$TMP/checksums.txt"

# Fail closed on a missing checksum entry or a corrupted download.
(cd "$TMP" && grep " $BINARY\$" checksums.txt | shasum -a 256 -c -)

# Write to a temp name in the target directory, then rename, so an
# interrupted install never leaves a truncated binary at $DEST.
install -m 755 "$TMP/$BINARY" "$DEST.tmp" && mv -f "$DEST.tmp" "$DEST"

# Say what '$NAME' actually resolves to now, so the closing hint is truthful.
RESOLVED="$(command -v "$NAME" || true)"
if [ "$RESOLVED" = "$DEST" ]; then
  echo "$NAME installed to $DEST - run '$NAME' to start."
elif [ -n "$RESOLVED" ]; then
  echo "$NAME installed to $DEST."
  echo "Note: '$NAME' currently resolves to $RESOLVED - the new binary wins only where $INSTALL_DIR comes first in your PATH. Run '$DEST' to use it."
else
  echo "$NAME installed to $DEST."
  echo "Note: '$NAME' is not on your PATH. Run '$DEST' to start, or add $INSTALL_DIR to your PATH."
fi