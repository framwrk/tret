#!/usr/bin/env bash
# Privileged end-to-end check for Tret (capture plan D8).
#
# It drives the *shipped* `tret` binary through the whole privileged flow on Linux:
#
#   1. `sudo tret install <url>` runs a local fixture installer as root. The fixture writes a
#      root-owned file under the dedicated path /opt/tret-e2e-fixture.
#   2. The resulting record carries privilege "root" and owns that root-owned file.
#   3. `tret uninstall <tool> --dry-run` as the non-root user reports that sudo is required and
#      leaves the root-owned file in place.
#   4. `sudo tret uninstall <tool> --yes` removes the root-owned file and drops the record.
#
# The fixture installer is served over loopback HTTP and every `tret` run gets its own temporary
# HOME, so no real user state is touched. The script skips with exit 0 (and a "skipped" message) on a
# host that cannot run it: a non-Linux host, an already-root process (the dry-run has to come from a
# non-root user), a host without sudo, a host whose sudo needs a password, and a host without bun.
# It never fails the suite for an environmental reason.
#
# Usage:
#   bash scripts/privileged-e2e.sh                     # uses dist/tret-linux-<arch>
#   TRET_BIN=/path/to/tret bash scripts/privileged-e2e.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$ROOT/scripts/privileged-e2e-check.ts"

# The fixture path belongs to this check alone. It is never a shared system path, so the check
# cannot damage the runner and the cleanup below can only ever remove what the fixture installer
# created. The script refuses to run over an existing one rather than delete unknown files.
FIXTURE_ROOT="/opt/tret-e2e-fixture"
TOOL="tret-e2e-tool"
ENTRY="$FIXTURE_ROOT/bin/$TOOL"

skip() {
  echo "privileged-e2e.sh: skipped: $1"
  exit 0
}

fail() {
  echo "privileged-e2e.sh: FAIL: $1" >&2
  exit 1
}

[ "$(uname -s)" = "Linux" ] || skip "not a Linux host (this check needs Linux)"
[ "$(id -u)" -ne 0 ] || skip "already running as root; the dry-run must come from a non-root user"
command -v sudo >/dev/null 2>&1 || skip "sudo is not installed"
sudo -n true >/dev/null 2>&1 || skip "sudo needs a password; this check needs passwordless sudo"
BUN="$(command -v bun || true)"
[ -n "$BUN" ] || skip "bun is not on PATH (the fixture server and the assertions need it)"
[ -f "$CHECK" ] || fail "missing $CHECK"

if [ -n "${TRET_BIN:-}" ]; then
  BIN="$(readlink -f "$TRET_BIN")"
else
  case "$(uname -m)" in
    aarch64 | arm64) ARCH="arm64" ;;
    x86_64 | amd64) ARCH="x64" ;;
    *) skip "unsupported architecture: $(uname -m)" ;;
  esac
  BIN="$ROOT/dist/tret-linux-$ARCH"
fi
[ -x "$BIN" ] || fail "missing $BIN; run 'bash scripts/build.sh linux-${ARCH:-x64}' first"

[ ! -e "$FIXTURE_ROOT" ] || fail "$FIXTURE_ROOT already exists; remove it and retry"

WORK="$(mktemp -d)"
HOME_DIR="$WORK/home"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  # The fixture is root-owned and the root steps leave root-owned files in the temporary HOME, so
  # both are removed as root. The trap runs on failure too, so a failed check leaves nothing behind.
  sudo -n rm -rf -- "$FIXTURE_ROOT" "$HOME_DIR" 2>/dev/null || true
  rm -rf -- "$WORK"
}
trap cleanup EXIT
mkdir -p "$HOME_DIR"

# The fixture installer. It runs as root (the whole install runs as root), so the file it writes is
# root-owned: the case the plan's D8 decision is about.
cat >"$WORK/install.sh" <<EOF
#!/bin/sh
set -eu
mkdir -p "$FIXTURE_ROOT/bin"
printf '#!/bin/sh\necho $TOOL\n' >"$ENTRY"
chmod 755 "$ENTRY"
EOF

# A loopback server for the fixture installer. `tret install` only accepts http(s) URLs with a dotted
# host, so 127.0.0.1 is used rather than localhost. The port is chosen by the OS (port 0).
cat >"$WORK/serve.ts" <<'EOF'
const script = await Bun.file(process.argv[2]!).text();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(script, { headers: { "content-type": "text/plain; charset=utf-8" } }),
});
console.log(server.port);
EOF

"$BUN" "$WORK/serve.ts" "$WORK/install.sh" >"$WORK/port" 2>"$WORK/serve.log" &
SERVER_PID=$!
PORT=""
for _ in $(seq 1 100); do
  PORT="$(head -n 1 "$WORK/port" 2>/dev/null || true)"
  [ -n "$PORT" ] && break
  sleep 0.1
done
[ -n "$PORT" ] || fail "the fixture server did not start: $(cat "$WORK/serve.log")"
URL="http://127.0.0.1:$PORT/install.sh"

# The real user's records file must not change: every `tret` run below runs with a temporary HOME.
REAL_RECORDS="${HOME:-}/.tret/records.json"
REAL_RECORDS_BEFORE="absent"
if [ -f "$REAL_RECORDS" ]; then REAL_RECORDS_BEFORE="$(sha256sum "$REAL_RECORDS" | cut -d' ' -f1)"; fi

echo "privileged-e2e.sh: 1/4 installing the fixture as root"
sudo -n env HOME="$HOME_DIR" PATH="$PATH" "$BIN" install "$URL" --yes --observe "$FIXTURE_ROOT" \
  >"$WORK/install.log" 2>&1 || {
  cat "$WORK/install.log" >&2
  fail "the root install exited non-zero"
}
[ -f "$ENTRY" ] || {
  cat "$WORK/install.log" >&2
  fail "the root install did not create $ENTRY"
}
[ "$(stat -c %u "$ENTRY")" = "0" ] || fail "$ENTRY is not owned by root"

echo "privileged-e2e.sh: 2/4 the record must be root-privileged and own the root-owned file"
NAME="$(sudo -n env HOME="$HOME_DIR" "$BIN" list --json | "$BUN" "$CHECK" name)" ||
  fail "the root install did not record exactly one tool"
sudo -n env HOME="$HOME_DIR" "$BIN" inspect "$NAME" --json >"$WORK/inspect.json" ||
  fail "tret inspect $NAME failed"
"$BUN" "$CHECK" installed "$NAME" "$ENTRY" <"$WORK/inspect.json" ||
  fail "the record is not a root-privileged record that owns $ENTRY"

# Hand the temporary HOME to the invoking user so the non-root dry-run can read the records the root
# run wrote and write its own run log. The records describe the same HOME the root run used, so this
# models one user who installed with sudo and then uninstalls without it.
sudo -n chown -R "$(id -u):$(id -g)" "$HOME_DIR"

echo "privileged-e2e.sh: 3/4 the non-root dry-run must report that sudo is required"
HOME="$HOME_DIR" "$BIN" uninstall "$NAME" --dry-run >"$WORK/dry-run.log" 2>&1 || {
  cat "$WORK/dry-run.log" >&2
  fail "the non-root dry-run exited non-zero"
}
# `tret` prints its human lines to the controlling terminal when stdout is not one, so the message is
# read from the run log it keeps under the temporary HOME, not from the captured output.
DRY_RUN_LOG="$(ls -t "$HOME_DIR"/.tret/logs/*-uninstall-*.log 2>/dev/null | head -n 1 || true)"
[ -n "$DRY_RUN_LOG" ] || fail "the non-root dry-run wrote no run log"
grep -q "re-run with sudo" "$DRY_RUN_LOG" || {
  cat "$WORK/dry-run.log" >&2
  fail "the non-root dry-run did not report that sudo is required"
}
HOME="$HOME_DIR" "$BIN" uninstall "$NAME" --dry-run --json >"$WORK/dry-run.json" 2>"$WORK/dry-run-json.log" || {
  cat "$WORK/dry-run-json.log" >&2
  fail "the non-root dry-run exited non-zero"
}
"$BUN" "$CHECK" requires-sudo "$NAME" "$ENTRY" <"$WORK/dry-run.json" ||
  fail "the non-root dry-run plan does not require sudo for $ENTRY"
[ -f "$ENTRY" ] || fail "the non-root dry-run removed the root-owned $ENTRY"

echo "privileged-e2e.sh: 4/4 the root uninstall must remove the root-owned file and drop the record"
sudo -n env HOME="$HOME_DIR" PATH="$PATH" "$BIN" uninstall "$NAME" --yes --json >"$WORK/uninstall.json" \
  2>"$WORK/uninstall.log" || {
  cat "$WORK/uninstall.log" >&2
  fail "the root uninstall exited non-zero"
}
"$BUN" "$CHECK" removed "$NAME" "$ENTRY" <"$WORK/uninstall.json" ||
  fail "the root uninstall did not remove $ENTRY"
[ ! -e "$ENTRY" ] || fail "the root uninstall left $ENTRY in place"
sudo -n env HOME="$HOME_DIR" "$BIN" list --json >"$WORK/list.json" ||
  fail "tret list failed after the root uninstall"
"$BUN" "$CHECK" dropped "$NAME" "$ENTRY" <"$WORK/list.json" ||
  fail "the root uninstall left the record tracked"

if [ "$REAL_RECORDS_BEFORE" = "absent" ]; then
  [ ! -e "$REAL_RECORDS" ] || fail "the run wrote $REAL_RECORDS outside the temporary HOME"
else
  REAL_RECORDS_AFTER="$(sha256sum "$REAL_RECORDS" | cut -d' ' -f1)"
  [ "$REAL_RECORDS_AFTER" = "$REAL_RECORDS_BEFORE" ] || fail "the run changed $REAL_RECORDS"
fi

echo "privileged-e2e.sh: passed"
