#!/usr/bin/env bash
# Installs the latest tidy release binary to ~/.tidy/bin/tidy, or under a
# name you pick when a tidy command already exists.
# Never asks for a password. Override the target directory with INSTALL_DIR.
set -euo pipefail

REPO="framwrk/Tidy"
BINARY="tidy-macos-arm64"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.tidy/bin}"
INSTALL_DIR="${INSTALL_DIR%/}"
RECORDS="$HOME/.tidy"

# macOS on Apple Silicon only, matching the compiled binary.
[ "$(uname -s)" = "Darwin" ] || { echo "tidy supports macOS only." >&2; exit 1; }
[ "$(uname -m)" = "arm64" ] || { echo "tidy supports Apple Silicon only." >&2; exit 1; }

# A pre-existing tidy command (macOS ships HTML tidy at /usr/bin/tidy) gets
# asked about: keep this install ahead of it in PATH, or pick another name.
# The answer comes from /dev/tty so a 'curl | bash' stdin stays untouched.
# An already-installed target binary counts as ours: reinstalling it over
# itself needs no question.
EXISTING="$(command -v tidy || true)"
NAME="tidy"
if [ -x "$INSTALL_DIR/tidy" ]; then
  :
elif [ -n "$EXISTING" ] && [ "$EXISTING" != "$INSTALL_DIR/tidy" ]; then
  if { true < /dev/tty; } 2>/dev/null; then
    echo "A 'tidy' command already exists: $EXISTING"
    echo "Install under the same name, or use another name. Either way, the"
    echo "new binary only wins where $INSTALL_DIR comes first in your PATH:"
    echo "  1) tidy     - same name; wins only where $INSTALL_DIR is ahead in PATH"
    echo "  2) tidyup"
    echo "  3) tdy"
    echo "  4) tidy-cli"
    echo "  5) tidytool"
    # Re-prompt until the choice is one of the listed options.
    while true; do
      printf "Choose [1]: "
      read -r CHOICE < /dev/tty || CHOICE=""
      case "${CHOICE:-1}" in
        1) NAME="tidy"; break ;;
        2) NAME="tidyup"; break ;;
        3) NAME="tdy"; break ;;
        4) NAME="tidy-cli"; break ;;
        5) NAME="tidytool"; break ;;
        *) echo "Invalid choice: '$CHOICE'. Enter 1-5." >&2 ;;
      esac
    done
  else
    echo "Note: a 'tidy' command already exists at $EXISTING - this install takes priority only where $INSTALL_DIR comes first in your PATH."
  fi
fi
DEST="$INSTALL_DIR/$NAME"

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
# skips pre-releases, and until 1.0 every tidy release is one.
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

# A previous install under another name left its binary behind; this script
# installed it and is now replacing it, so remove it before re-recording.
PREV="$(cat "$RECORDS/binary-name" 2>/dev/null || true)"
if [ -n "$PREV" ] && [ "$PREV" != "$NAME" ] && [ -e "$INSTALL_DIR/$PREV" ]; then
  rm -f "$INSTALL_DIR/$PREV"
fi

# Record the installed name so uninstall.sh finds the binary whatever it is.
mkdir -p "$RECORDS"
echo "$NAME" > "$RECORDS/binary-name"

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