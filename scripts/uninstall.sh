#!/usr/bin/env bash
# Removes the tidy binary. Pass --purge to also delete tidy's records.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"
DEST="$INSTALL_DIR/tidy"
RECORDS="$HOME/Library/Application Support/Tidy"

if [ -f "$DEST" ]; then
  if [ -w "$INSTALL_DIR" ]; then
    rm "$DEST"
  else
    sudo rm "$DEST"
  fi
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