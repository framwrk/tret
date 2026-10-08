#!/usr/bin/env bash
# Installs the latest tret release binary to ~/.tret/bin/tret and links it as
# ~/.local/bin/tret. Shell rc files are never touched. Never asks for a
# password.
set -euo pipefail

REPO="framwrk/tret"
BINARY="tret-macos-arm64"
INSTALL_DIR="$HOME/.tret/bin"

# macOS on Apple Silicon only, matching the compiled binary.
[ "$(uname -s)" = "Darwin" ] || { echo "tret supports macOS only." >&2; exit 1; }
[ "$(uname -m)" = "arm64" ] || { echo "tret supports Apple Silicon only." >&2; exit 1; }

NAME="tret"
DEST="$INSTALL_DIR/$NAME"

# The command lives on PATH through a symlink in ~/.local/bin, the way the
# pro tools do it: one standard, user-writable directory that is almost
# always already on PATH, so no shell rc file ever needs editing.
LINK_DIR="$HOME/.local/bin"
LINK="$LINK_DIR/$NAME"

# Make sure $LINK is a symlink to $DEST. Leaves a foreign file or symlink at
# the link path alone and says so.
ensure_link() {
  if [ -L "$LINK" ] && [ "$(readlink "$LINK" || true)" = "$DEST" ]; then
    return 0
  fi
  if [ -e "$LINK" ] || [ -L "$LINK" ]; then
    echo "Note: $LINK already exists and is not a tret symlink - tret was not linked there." >&2
    return 1
  fi
  mkdir -p "$LINK_DIR" 2>/dev/null || {
    echo "$LINK_DIR could not be created." >&2
    return 1
  }
  ln -s "$DEST" "$LINK" || {
    echo "Could not create $LINK." >&2
    return 1
  }
}

EXISTING="$(command -v "$NAME" || true)"
if [ ! -x "$DEST" ] && [ -n "$EXISTING" ] && [ "$EXISTING" != "$DEST" ]; then
  echo "Note: a 'tret' command already exists at $EXISTING - this install takes priority only where $LINK_DIR comes first in your PATH."
fi

# Install without sudo: the target is user-writable. An unwritable target
# fails instead of falling back to sudo.
if [ -d "$INSTALL_DIR" ] && [ ! -w "$INSTALL_DIR" ]; then
  echo "$INSTALL_DIR is not writable." >&2
  exit 1
fi
mkdir -p "$INSTALL_DIR" 2>/dev/null || {
  echo "$INSTALL_DIR could not be created." >&2
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
# The API body may be minified (one line) or pretty-printed, so match the
# tag_name field itself instead of relying on line positions. -m stops after
# one matching LINE, so with -o it would still print every tag_name on a
# one-line body; head keeps only the first, which is the newest release.
TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases" | { grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' || true; } | head -n1 | cut -d'"' -f4)" ||
  { echo "Could not read releases for $REPO from the GitHub API." >&2; exit 1; }
[ -n "$TAG" ] && [ "${TAG#v}" != "$TAG" ] || {
  echo "No release tag found for $REPO - is there a published release?" >&2
  exit 1
}
BASE="https://github.com/$REPO/releases/download/$TAG"
curl -fsSL "$BASE/checksums.txt" -o "$TMP/checksums.txt"

# The release checksum for $BINARY. An empty result means no entry for the
# binary, and the install fails here instead of skipping verification.
EXPECTED="$(grep " $BINARY\$" "$TMP/checksums.txt" | cut -d' ' -f1)" ||
  { echo "No checksum entry for $BINARY in $TAG's checksums.txt." >&2; exit 1; }

# A hash match means the newest release is already installed: say so and
# skip the download. A locally built binary never matches and gets updated,
# and so does a matching binary whose execute bit was lost. A directory at
# $DEST cannot be replaced by an install, so refuse instead of letting mv
# file the new binary inside it.
if [ -d "$DEST" ]; then
  echo "$DEST is a directory - remove it and rerun the install." >&2
  exit 1
fi

# The symlink is repaired even on the up-to-date path: a rerun after a
# deleted link restores it without redownloading the binary.
ensure_link || exit 1

if [ -f "$DEST" ] && [ -x "$DEST" ]; then
  INSTALLED="$(shasum -a 256 "$DEST" 2>/dev/null | cut -d' ' -f1 || true)"
  if [ "$INSTALLED" = "$EXPECTED" ]; then
    echo "tret is already up to date at $DEST (release $TAG)."
    exit 0
  fi
fi

curl -fsSL "$BASE/$BINARY" -o "$TMP/$BINARY"

# Fail closed on a corrupted download.
(cd "$TMP" && grep " $BINARY\$" checksums.txt | shasum -a 256 -c -)

# Write to a temp name in the target directory, then rename, so an
# interrupted install never leaves a truncated binary at $DEST.
install -m 755 "$TMP/$BINARY" "$DEST.tmp" && mv -f "$DEST.tmp" "$DEST"

# Say what '$NAME' actually resolves to now, so the closing hints are truthful.
RESOLVED="$(command -v "$NAME" || true)"

if [ "$RESOLVED" = "$LINK" ]; then
  echo "$NAME installed to $DEST - run '$NAME' to start."
elif [ -n "$RESOLVED" ]; then
  echo "$NAME installed to $DEST ($LINK -> $DEST)."
  echo "Note: '$NAME' currently resolves to $RESOLVED - the new install wins only where $LINK_DIR comes first in your PATH."
else
  echo "$NAME installed to $DEST ($LINK -> $DEST)."
  case ":$PATH:" in
    *":$LINK_DIR:"*) ;;
    *)
      echo "Note: $LINK_DIR is not on this shell's PATH - add it to your shell profile to use '$NAME'."
      ;;
  esac
fi