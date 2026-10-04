#!/usr/bin/env bash
# Removes the tret binary. Asks for confirmation first.
# Never asks for a password.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/.tret/bin}"
RECORDS="$HOME/.tret"

DEST="$INSTALL_DIR/tret"

if [ -f "$DEST" ]; then
  if { true < /dev/tty; } 2>/dev/null; then
    printf "Remove %s? [y/N] " "$DEST" > /dev/tty
    read -r ANSWER < /dev/tty || ANSWER=""
    case "$ANSWER" in
      y|Y|yes|Yes|YES)
        rm "$DEST"
        echo "Removed $DEST"
        ;;
      *)
        echo "Aborted. $DEST left in place."
        ;;
    esac
  else
    echo "No terminal to confirm with. Run this script interactively to remove $DEST." >&2
    exit 1
  fi
else
  echo "No tret binary at $DEST. If you installed to a custom directory, re-run with INSTALL_DIR set."
fi

echo "Records kept at $RECORDS. To remove them, run: rm -rf \"$RECORDS\""