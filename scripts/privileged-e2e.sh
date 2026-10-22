#!/usr/bin/env bash
# Privileged end-to-end check for tret (plan D8). It drives the shipped binary through three steps:
#
#   1. `sudo tret install` of a local fixture installer that writes a root-owned file under
#      /opt/tret-e2e-fixture. The record must carry privilege "root" and own that file.
#   2. `tret uninstall --dry-run` as the invoking non-root user. The plan must report that sudo is
#      required and must leave the root-owned file in place.
#   3. `sudo tret uninstall --yes`. The root-owned file is removed and its record is dropped.
#
# The fixture is served over loopback HTTP and HOME is a private temp directory, so no real user
# state is touched. Skips with exit 0 (never fails the suite) on non-Linux hosts, when run as root
# (the dry-run needs a non-root invoker), or when passwordless sudo or bun is unavailable.
# Set TRET_BIN to test another binary; by default it is dist/tret-linux-<arch> from scripts/build.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE="/opt/tret-e2e-fixture"
TOOL="tret-e2e-tool"
ENTRY="$FIXTURE/bin/$TOOL"

skip() {
  echo "privileged-e2e.sh: skipped: $1"
  exit 0
}

fail() {
  echo "privileged-e2e.sh: FAIL: $1" >&2
  exit 1
}

[ "$(uname -s)" = "Linux" ] || skip "not a Linux host"
[ "$(id -u)" -ne 0 ] || skip "run as a non-root user with sudo; the dry-run must come from a non-root user"
command -v sudo >/dev/null 2>&1 || skip "sudo is not installed"
sudo -n true >/dev/null 2>&1 || skip "passwordless sudo is unavailable"
BUN="$(command -v bun || true)"
[ -n "$BUN" ] || skip "bun is not on PATH"
# The fixture path is dedicated to this test. Refuse to run over an existing one rather than delete it.
[ ! -e "$FIXTURE" ] || fail "$FIXTURE already exists; remove it before running this test"

if [ -n "${TRET_BIN:-}" ]; then
  BIN="$(readlink -f "$TRET_BIN")"
else
  case "$(uname -m)" in
    aarch64 | arm64) ARCH="arm64" ;;
    x86_64 | amd64) ARCH="x64" ;;
    *) skip "unsupported arch: $(uname -m)" ;;
  esac
  BIN="$ROOT/dist/tret-linux-$ARCH"
fi
[ -x "$BIN" ] || fail "missing $BIN; run scripts/build.sh linux-${ARCH:-x64} first"

WORK="$(mktemp -d)"
HOME_DIR="$WORK/home"
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  # The fixture is root-owned, and the temp HOME may be too after the root steps, so remove both as root.
  sudo -n rm -rf -- "$FIXTURE" "$HOME_DIR" 2>/dev/null || true
  rm -rf -- "$WORK"
}
trap cleanup EXIT
mkdir -p "$HOME_DIR" "$WORK/serve"

# The fixture installer: a root run creates a root-owned executable under the dedicated fixture path.
cat >"$WORK/serve/install.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$FIXTURE/bin"
printf '#!/bin/sh\necho $TOOL\n' >"$ENTRY"
chmod 755 "$ENTRY"
EOF

# A loopback server for the fixture. Tret only accepts http(s) URLs with a dotted host, so
# 127.0.0.1 is used rather than localhost. The port is chosen by the OS (port 0).
cat >"$WORK/serve.ts" <<'EOF'
const root = process.argv[2] ?? "";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const file = Bun.file(root + new URL(request.url).pathname);
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});
console.log(server.port);
EOF

# Checks one record in the records file on stdin. `installed` needs exactly one record named TOOL with
# privilege "root" that owns ENTRY; `dropped` needs no record named TOOL.
cat >"$WORK/verify.ts" <<'EOF'
const [mode, tool, entry] = process.argv.slice(2);
type Record = { name: string; privilege: string; owned: { path: string }[] };
const { records } = JSON.parse(await Bun.stdin.text()) as { records: Record[] };
const matches = records.filter((record) => record.name === tool);
const fail = (message: string): never => {
  console.error(`verify: ${message}`);
  process.exit(1);
};
if (mode === "installed") {
  if (matches.length !== 1) fail(`expected one record named ${tool}, found ${matches.length}`);
  const [record] = matches as [Record];
  if (record.privilege !== "root") fail(`record privilege is ${record.privilege}, expected root`);
  if (!record.owned.some((owned) => owned.path === entry)) fail(`record does not own ${entry}`);
} else if (mode === "dropped") {
  if (matches.length !== 0) fail(`record ${tool} is still tracked`);
} else {
  fail(`unknown mode ${mode}`);
}
EOF

PORT=""
"$BUN" "$WORK/serve.ts" "$WORK/serve" >"$WORK/port" 2>"$WORK/serve.log" &
SERVER_PID=$!
for _ in $(seq 1 100); do
  PORT="$(cat "$WORK/port" 2>/dev/null || true)"
  [ -n "$PORT" ] && break
  sleep 0.1
done
[ -n "$PORT" ] || fail "fixture server did not start: $(cat "$WORK/serve.log")"
URL="http://127.0.0.1:$PORT/install.sh"

echo "privileged-e2e.sh: 1/3 root install of $URL"
sudo -n env HOME="$HOME_DIR" PATH="$PATH" "$BIN" install "$URL" --yes --observe "$FIXTURE" >"$WORK/install.log" 2>&1 ||
  { cat "$WORK/install.log" >&2; fail "root install exited non-zero"; }
sudo -n cat "$HOME_DIR/.tret/records.json" | "$BUN" "$WORK/verify.ts" installed "$TOOL" "$ENTRY" ||
  { cat "$WORK/install.log" >&2; fail "root install record is wrong"; }
[ -f "$ENTRY" ] || fail "root install did not create $ENTRY"

# Hand the HOME to the invoking user so its dry-run can read the records and write its run log. The
# records describe the same HOME the root run wrote, so this models one user with two identities.
sudo -n chown -R "$(id -u):$(id -g)" "$HOME_DIR"

echo "privileged-e2e.sh: 2/3 non-root dry-run must report that sudo is required"
HOME="$HOME_DIR" "$BIN" uninstall "$TOOL" --dry-run >"$WORK/dry-run.log" 2>&1 ||
  { cat "$WORK/dry-run.log" >&2; fail "non-root dry-run exited non-zero"; }
grep -q "re-run with sudo" "$WORK/dry-run.log" ||
  { cat "$WORK/dry-run.log" >&2; fail "non-root dry-run did not report that sudo is required"; }
[ -f "$ENTRY" ] || fail "non-root dry-run removed the root-owned $ENTRY"

echo "privileged-e2e.sh: 3/3 root uninstall must remove the root-owned entry and drop the record"
sudo -n env HOME="$HOME_DIR" PATH="$PATH" "$BIN" uninstall "$TOOL" --yes >"$WORK/uninstall.log" 2>&1 ||
  { cat "$WORK/uninstall.log" >&2; fail "root uninstall exited non-zero"; }
[ ! -e "$ENTRY" ] || fail "root uninstall left $ENTRY in place"
sudo -n cat "$HOME_DIR/.tret/records.json" | "$BUN" "$WORK/verify.ts" dropped "$TOOL" "$ENTRY" ||
  fail "root uninstall left the record tracked"

echo "privileged-e2e.sh: passed"
