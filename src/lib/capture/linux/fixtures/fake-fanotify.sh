#!/bin/sh
# Minimal `tret-fanotify` helper double for tests.
#
# The real helper (helper/tret-fanotify.c) runs fanotify and emits newline-delimited TracerRecord
# JSON. This double replays records from $TRET_FANOTIFY_EVENTS and can emit a control `@loss` line to
# stderr so coverage downgrading is exercised without root.
set -eu

if [ -n "${TRET_FANOTIFY_LOSS:-}" ]; then
  printf '@loss %s\n' "$TRET_FANOTIFY_LOSS" >&2
fi

if [ -z "${TRET_FANOTIFY_EVENTS:-}" ]; then
  echo "fake-fanotify: TRET_FANOTIFY_EVENTS is not set" >&2
  exit 1
fi

exec cat "$TRET_FANOTIFY_EVENTS"
