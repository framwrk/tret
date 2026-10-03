#!/usr/bin/env bash
# Removes the tidy binary. Pass --purge to also delete tidy's records.
# Never asks for a password.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
RECORDS="$HOME/Library/Application Support/Tidy"

# The install may have picked another name when a tidy command already existed.
NAME=""
if [ -f "$RECORDS/binary-name" ]; then NAME="$(cat "$RECORDS/binary-name")"; fi
NAME="${NAME:-tidy}"
DEST="$INSTALL_DIR/$NAME"

if [ -f "$DEST" ]; then
  rm "$DEST"
  echo "Removed $DEST"
else
  echo "No tidy binary at $DEST. If you installed to a custom directory, re-run with INSTALL_DIR set."
fi

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$RECORDS"
  echo "Removed records at $RECORDS"
else
  echo "Records kept at $RECORDS (re-run with --purge to delete them)"
fi
