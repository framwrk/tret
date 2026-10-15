#!/usr/bin/env bash
# Removes the tret binary and its ~/.local/bin symlink. Asks for
# confirmation first. Never asks for a password.
set -euo pipefail

INSTALL_DIR="$HOME/.tret/bin"
RECORDS="$HOME/.tret"

DEST="$INSTALL_DIR/tret"
HELPER="$INSTALL_DIR/tret-fanotify"
LINK="$HOME/.local/bin/tret"

# Collect what is actually ours to remove: the binary, the privileged capture
# helper shipped beside it, and the symlink only when it points at the binary
# (a foreign file at the link path stays).
TO_REMOVE=""
if [ -f "$DEST" ]; then
  TO_REMOVE="$DEST"
fi
if [ -f "$HELPER" ]; then
  [ -n "$TO_REMOVE" ] && TO_REMOVE="$TO_REMOVE, "
  TO_REMOVE="${TO_REMOVE}$HELPER"
fi
if [ -L "$LINK" ] && [ "$(readlink "$LINK" || true)" = "$DEST" ]; then
  [ -n "$TO_REMOVE" ] && TO_REMOVE="$TO_REMOVE, "
  TO_REMOVE="${TO_REMOVE}$LINK"
fi

if [ -n "$TO_REMOVE" ]; then
  if { true < /dev/tty; } 2>/dev/null; then
    printf "Remove %s? [y/N] " "$TO_REMOVE" > /dev/tty
    read -r ANSWER < /dev/tty || ANSWER=""
    case "$ANSWER" in
      y|Y|yes|Yes|YES)
        [ -f "$DEST" ] && rm "$DEST" && echo "Removed $DEST"
        [ -f "$HELPER" ] && rm "$HELPER" && echo "Removed $HELPER"
        if [ -L "$LINK" ]; then
          rm "$LINK"
          echo "Removed $LINK"
        fi
        ;;
      *)
        echo "Aborted. $TO_REMOVE left in place."
        ;;
    esac
  else
    echo "No terminal to confirm with. Run this script interactively to remove $TO_REMOVE." >&2
    exit 1
  fi
else
  echo "No tret binary at $DEST."
fi

echo "Records kept at $RECORDS. To remove them, run: rm -rf \"$RECORDS\""
