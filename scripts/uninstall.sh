#!/usr/bin/env bash
# Removes the tret binary. Pass --purge to also delete tret's records.
# Never asks for a password.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/.tret/bin}"
RECORDS="$HOME/.tret"

DEST="$INSTALL_DIR/tret"

if [ -f "$DEST" ]; then
  rm "$DEST"
  echo "Removed $DEST"
else
  echo "No tret binary at $DEST. If you installed to a custom directory, re-run with INSTALL_DIR set."
fi

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$RECORDS"
  echo "Removed records at $RECORDS"
else
  echo "Records kept at $RECORDS (re-run with --purge to delete them)"
fi