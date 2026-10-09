#!/bin/sh
# Minimal `strace` double for the Linux capture backend integration fixture.
#
# It accepts the argument shape StraceTracer emits (`strace -f -ttt -y -qq -e trace=... -o FILE -p
# PID`), ignores the ptrace flags, and runs the fake installer with its stdout (the trace stream)
# redirected to FILE. This lets StraceTracer's spawn/parse path be exercised on any host.
set -eu

out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o)
      out="$2"
      shift 2
      ;;
    -e | -p | -s | --)
      shift 2
      ;;
    -f | -ttt | -y | -qq)
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [ -z "${TRET_FAKE_INSTALLER:-}" ]; then
  echo "fake-strace: TRET_FAKE_INSTALLER is not set" >&2
  exit 1
fi

if [ -n "$out" ]; then
  exec "$TRET_FAKE_INSTALLER" > "$out"
else
  exec "$TRET_FAKE_INSTALLER"
fi
