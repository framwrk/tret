#!/usr/bin/env bash
# Privileged end-to-end check for Tret (capture plan D8, verification item V5).
#
# It drives the *shipped* `tret` binary through the privileged flow on Linux, in two separate runs
# that select the two privileged capture backends explicitly:
#
#   strace    `sudo tret install <url>` runs a local fixture installer as root with no fanotify
#             helper discoverable. The record must report `capture.backend: "linux-strace"`, carry
#             privilege "root", and own the root-owned fixture file. Then `tret uninstall <tool>
#             --dry-run` as the non-root user must report that sudo is required and leave the
#             root-owned file in place, and `sudo tret uninstall <tool> --yes` must remove it and
#             drop the record.
#
#   fanotify  `sudo tret install <url>` runs the same fixture from a staged copy of the packaged
#             binary with the packaged `tret-fanotify` helper staged beside it. The record must
#             report `capture.backend: "linux-fanotify"` and privilege "root". This run proves the
#             *selection* only: the shipped helper's documented F1-F4 fidelity gaps (see
#             docs/capture/linux-fidelity.md and docs/capture/linux-capture.md) mean it does not
#             attribute the fixture file correctly, so its record is not claimed as proven and no
#             ownership or uninstall assertion is made for it. A helper that cannot attach at all is
#             a hard failure that reports the kernel's loss reason, never a skipped assertion.
#
# The fixture installer is served over loopback HTTP and every `tret` run gets its own temporary
# HOME, so no real user state is touched. Each run uses its own unique fixture path under /opt, and
# the trap removes every fixture path and temporary HOME even when a step fails.
#
# The script skips with exit 0 (and a "skipped" message) on a host that cannot run it: a non-Linux
# host, an already-root process (the dry-run has to come from a non-root user), a host without sudo,
# a host whose sudo needs a password, and a host without bun. It never fails the suite for an
# environmental reason.
#
# Usage:
#   bash scripts/privileged-e2e.sh                     # uses dist/tret-linux-<arch>
#   TRET_BIN=/path/to/tret bash scripts/privileged-e2e.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$ROOT/scripts/privileged-e2e-check.ts"
TOOL="tret-e2e-tool"

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

case "$(uname -m)" in
  aarch64 | arm64) ARCH="arm64" ;;
  x86_64 | amd64) ARCH="x64" ;;
  *) skip "unsupported architecture: $(uname -m)" ;;
esac

if [ -n "${TRET_BIN:-}" ]; then
  BIN="$(readlink -f "$TRET_BIN")"
else
  BIN="$ROOT/dist/tret-linux-$ARCH"
fi
[ -x "$BIN" ] || fail "missing $BIN; run 'bash scripts/build.sh linux-$ARCH' first"

# The fanotify half needs the packaged C helper. Accept an explicit TRET_FANOTIFY override, a
# helper already beside TRET_BIN (the release archive layout), or the raw artifact scripts/build.sh
# writes for a native Linux build. The helper is then staged beside a staged copy of the binary, so
# the run exercises the same beside-the-binary discovery release users get.
HELPER_SOURCE="${TRET_FANOTIFY:-}"
if [ -z "$HELPER_SOURCE" ] && [ -x "$(dirname "$BIN")/tret-fanotify" ]; then
  HELPER_SOURCE="$(dirname "$BIN")/tret-fanotify"
fi
if [ -z "$HELPER_SOURCE" ] && [ -x "$ROOT/dist/tret-fanotify-linux-$ARCH" ]; then
  HELPER_SOURCE="$ROOT/dist/tret-fanotify-linux-$ARCH"
fi
[ -n "$HELPER_SOURCE" ] ||
  fail "no tret-fanotify helper found; run 'bash scripts/build.sh linux-$ARCH' or set TRET_FANOTIFY"
HELPER_SOURCE="$(readlink -f "$HELPER_SOURCE")"
[ -f "$HELPER_SOURCE" ] && [ -x "$HELPER_SOURCE" ] || fail "$HELPER_SOURCE is not an executable file"

# Unique fixture paths under /opt for this invocation, one per run. They are never shared system
# paths, the trap removes them, and the fixture installer refuses to write anywhere else.
RUN_ID="$$-$RANDOM"
FIXTURE_STRACE="/opt/tret-e2e-strace-$RUN_ID"
FIXTURE_FANOTIFY="/opt/tret-e2e-fanotify-$RUN_ID"
[ ! -e "$FIXTURE_STRACE" ] || fail "$FIXTURE_STRACE already exists; remove it and retry"
[ ! -e "$FIXTURE_FANOTIFY" ] || fail "$FIXTURE_FANOTIFY already exists; remove it and retry"

WORK="$(mktemp -d)"
HOME_STRACE="$WORK/home-strace"
HOME_FANOTIFY="$WORK/home-fanotify"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  # The fixtures and the root steps' files in the temporary HOMEs are root-owned, so the trap
  # removes them as root. The trap runs on failure too, so a failed check leaves nothing behind.
  sudo -n rm -rf -- "$FIXTURE_STRACE" "$FIXTURE_FANOTIFY" "$HOME_STRACE" "$HOME_FANOTIFY" 2>/dev/null || true
  rm -rf -- "$WORK"
}
trap cleanup EXIT

mkdir -p "$HOME_STRACE" "$HOME_FANOTIFY"

# A copy of the packaged binary with no helper beside it: root has no fanotify helper discoverable,
# so the strace backend must be selected even when the original dist/ directory has one.
STRACE_BIN_DIR="$WORK/strace-bin"
mkdir -p "$STRACE_BIN_DIR"
cp -- "$BIN" "$STRACE_BIN_DIR/tret"
chmod 755 "$STRACE_BIN_DIR/tret"
STRACE_BIN="$STRACE_BIN_DIR/tret"

# A copy of the packaged binary with the packaged helper beside it, matching the release archive.
FANOTIFY_BIN_DIR="$WORK/fanotify-bin"
mkdir -p "$FANOTIFY_BIN_DIR"
cp -- "$BIN" "$FANOTIFY_BIN_DIR/tret"
cp -- "$HELPER_SOURCE" "$FANOTIFY_BIN_DIR/tret-fanotify"
chmod 755 "$FANOTIFY_BIN_DIR/tret" "$FANOTIFY_BIN_DIR/tret-fanotify"
FANOTIFY_BIN="$FANOTIFY_BIN_DIR/tret"

# The fixture installer. It runs as root (the whole install runs as root), so the file it writes is
# root-owned: the case the plan's D8 decision is about. It reads the run's fixture root from the
# environment and refuses any path outside the check's own /opt/tret-e2e-* namespace.
cat >"$WORK/install.sh" <<EOF
#!/bin/sh
set -eu
case "\${E2E_FIXTURE_ROOT:-}" in
  /opt/tret-e2e-*) ;;
  *) echo "fixture: refusing an unexpected root: \${E2E_FIXTURE_ROOT:-<unset>}" >&2; exit 1 ;;
esac
mkdir -p "\$E2E_FIXTURE_ROOT/bin"
printf '#!/bin/sh\necho $TOOL\n' >"\$E2E_FIXTURE_ROOT/bin/$TOOL"
chmod 755 "\$E2E_FIXTURE_ROOT/bin/$TOOL"
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

# Runs the fixture install as root with a temporary HOME and the run's own fixture root. The
# `--observe` root is created first so the fanotify helper can mark an existing directory; it stays
# empty until the installer runs.
install_fixture() {
  local label="$1" home="$2" root="$3" bin="$4"
  sudo -n mkdir -p -- "$root" || return 1
  sudo -n env -u TRET_FANOTIFY HOME="$home" PATH="$PATH" E2E_FIXTURE_ROOT="$root" \
    "$bin" install "$URL" --yes --observe "$root" >"$WORK/$label-install.log" 2>&1
}

inspect_capture() {
  local label="$1" home="$2" name="$3" entry="$4" backend="$5" completeness="${6:-}"
  sudo -n env HOME="$home" "$BIN" inspect "$name" --json >"$WORK/$label-inspect.json" ||
    fail "tret inspect $name failed in the $label run"
  "$BUN" "$CHECK" capture "$name" "$entry" "$backend" "$completeness" <"$WORK/$label-inspect.json" ||
    fail "the $label run did not select capture.backend $backend"
}

# The strace run must have no fanotify helper discoverable: its staged binary has no adjacent
# helper, its HOME is empty, and TRET_FANOTIFY is unset for every install below.
[ ! -e "$STRACE_BIN_DIR/tret-fanotify" ] || fail "$STRACE_BIN_DIR unexpectedly contains a helper"
[ ! -e "$HOME_STRACE/.tret/bin/tret-fanotify" ] || fail "the strace HOME unexpectedly contains a helper"

echo "privileged-e2e.sh: [strace] 1/4 installing the fixture as root"
set +e
install_fixture strace "$HOME_STRACE" "$FIXTURE_STRACE" "$STRACE_BIN"
STRACE_INSTALL_STATUS=$?
set -e
[ "$STRACE_INSTALL_STATUS" -eq 0 ] || {
  cat "$WORK/strace-install.log" >&2
  fail "the root install exited $STRACE_INSTALL_STATUS"
}
STRACE_ENTRY="$FIXTURE_STRACE/bin/$TOOL"
[ -f "$STRACE_ENTRY" ] || {
  cat "$WORK/strace-install.log" >&2
  fail "the root install did not create $STRACE_ENTRY"
}
[ "$(stat -c %u "$STRACE_ENTRY")" = "0" ] || fail "$STRACE_ENTRY is not owned by root"

echo "privileged-e2e.sh: [strace] 2/4 the record must be root-privileged, own the file, and report linux-strace"
STRACE_NAME="$(sudo -n env HOME="$HOME_STRACE" "$BIN" list --json | "$BUN" "$CHECK" name)" || {
  cat "$WORK/strace-install.log" >&2
  fail "the root install did not record exactly one tool"
}
inspect_capture strace "$HOME_STRACE" "$STRACE_NAME" "$STRACE_ENTRY" linux-strace
"$BUN" "$CHECK" installed "$STRACE_NAME" "$STRACE_ENTRY" <"$WORK/strace-inspect.json" ||
  fail "the record is not a root-privileged record that owns $STRACE_ENTRY"

# Hand the temporary HOME to the invoking user so the non-root dry-run can read the records the root
# run wrote and write its own run log. The records describe the same HOME the root run used, so this
# models one user who installed with sudo and then uninstalls without it.
sudo -n chown -R "$(id -u):$(id -g)" "$HOME_STRACE"

echo "privileged-e2e.sh: [strace] 3/4 the non-root dry-run must report that sudo is required"
HOME="$HOME_STRACE" "$BIN" uninstall "$STRACE_NAME" --dry-run >"$WORK/dry-run.log" 2>&1 || {
  cat "$WORK/dry-run.log" >&2
  fail "the non-root dry-run exited non-zero"
}
# `tret` prints its human lines to the controlling terminal when stdout is not one, so the message is
# read from the run log it keeps under the temporary HOME, not from the captured output.
DRY_RUN_LOG="$(ls -t "$HOME_STRACE"/.tret/logs/*-uninstall-*.log 2>/dev/null | head -n 1 || true)"
[ -n "$DRY_RUN_LOG" ] || fail "the non-root dry-run wrote no run log"
grep -q "re-run with sudo" "$DRY_RUN_LOG" || {
  cat "$WORK/dry-run.log" >&2
  fail "the non-root dry-run did not report that sudo is required"
}
HOME="$HOME_STRACE" "$BIN" uninstall "$STRACE_NAME" --dry-run --json >"$WORK/dry-run.json" 2>"$WORK/dry-run-json.log" || {
  cat "$WORK/dry-run-json.log" >&2
  fail "the non-root dry-run exited non-zero"
}
"$BUN" "$CHECK" requires-sudo "$STRACE_NAME" "$STRACE_ENTRY" <"$WORK/dry-run.json" ||
  fail "the non-root dry-run plan does not require sudo for $STRACE_ENTRY"
[ -f "$STRACE_ENTRY" ] || fail "the non-root dry-run removed the root-owned $STRACE_ENTRY"

echo "privileged-e2e.sh: [strace] 4/4 the root uninstall must remove the root-owned file and drop the record"
sudo -n env HOME="$HOME_STRACE" PATH="$PATH" "$BIN" uninstall "$STRACE_NAME" --yes --json >"$WORK/uninstall.json" \
  2>"$WORK/uninstall.log" || {
  cat "$WORK/uninstall.log" >&2
  fail "the root uninstall exited non-zero"
}
"$BUN" "$CHECK" removed "$STRACE_NAME" "$STRACE_ENTRY" <"$WORK/uninstall.json" ||
  fail "the root uninstall did not remove $STRACE_ENTRY"
[ ! -e "$STRACE_ENTRY" ] || fail "the root uninstall left $STRACE_ENTRY in place"
sudo -n env HOME="$HOME_STRACE" "$BIN" list --json >"$WORK/list.json" ||
  fail "tret list failed after the root uninstall"
"$BUN" "$CHECK" dropped "$STRACE_NAME" "$STRACE_ENTRY" <"$WORK/list.json" ||
  fail "the root uninstall left the record tracked"

echo "privileged-e2e.sh: [fanotify] installing the fixture as root with the packaged helper beside the binary"
set +e
install_fixture fanotify "$HOME_FANOTIFY" "$FIXTURE_FANOTIFY" "$FANOTIFY_BIN"
FANOTIFY_INSTALL_STATUS=$?
set -e
# The shipped helper is documented as not attributing directory entries correctly (F1-F4), so this
# install may legitimately exit non-zero after saving a partial record. Accept either outcome as
# long as the record exists and reports the fanotify backend; never claim its capture is proven.
case "$FANOTIFY_INSTALL_STATUS" in
  0 | 1) ;;
  *)
    cat "$WORK/fanotify-install.log" >&2
    fail "the fanotify root install exited $FANOTIFY_INSTALL_STATUS"
    ;;
esac
FANOTIFY_ENTRY="$FIXTURE_FANOTIFY/bin/$TOOL"
FANOTIFY_NAME="$(sudo -n env HOME="$HOME_FANOTIFY" "$BIN" list --json | "$BUN" "$CHECK" name)" || {
  cat "$WORK/fanotify-install.log" >&2
  # The shipped helper requests FAN_CREATE, FAN_ATTRIB and FAN_MOVED_* together with
  # FAN_MARK_MOUNT. The kernel rejects that combination with EINVAL (mount marks may only request
  # events that can be reported with an fd), so the helper can never attach. Keep the backend
  # assertion strict and name the reproduction instead of accepting the empty record.
  if grep -q "fanotify_mark failed" "$WORK/fanotify-install.log"; then
    fail "linux-fanotify was selected but the packaged helper could not mark an observe root: fanotify_mark rejected its mask (FAN_MARK_MOUNT with FAN_CREATE/FAN_ATTRIB/FAN_MOVED_*) with EINVAL, so it captured no events and saved no record. This is a product bug in src/lib/capture/linux/helper/tret-fanotify.c; the assertion is intentionally not weakened."
  fi
  fail "the fanotify root install did not record exactly one tool"
}
inspect_capture fanotify "$HOME_FANOTIFY" "$FANOTIFY_NAME" "$FANOTIFY_ENTRY" linux-fanotify
echo "privileged-e2e.sh: note: linux-fanotify was selected; the shipped helper's documented F1-F4"
echo "privileged-e2e.sh:       fidelity gaps mean this proves backend selection, not capture accuracy"

if [ "$REAL_RECORDS_BEFORE" = "absent" ]; then
  [ ! -e "$REAL_RECORDS" ] || fail "the run wrote $REAL_RECORDS outside the temporary HOME"
else
  REAL_RECORDS_AFTER="$(sha256sum "$REAL_RECORDS" | cut -d' ' -f1)"
  [ "$REAL_RECORDS_AFTER" = "$REAL_RECORDS_BEFORE" ] || fail "the run changed $REAL_RECORDS"
fi

echo "privileged-e2e.sh: passed"
