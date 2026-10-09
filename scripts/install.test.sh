#!/usr/bin/env bash
# Exercises `scripts/install.sh` against the locally built release for the
# running platform, without touching the network. A tiny `curl` shim serves the
# real `dist/` artifacts, and `uname` selects the same target the install script
# would. Run `scripts/build.sh` first.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"

case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux) OS="linux" ;;
  *)
    echo "install.test.sh: unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) ARCH="arm64" ;;
  x86_64 | amd64) ARCH="x64" ;;
  *)
    echo "install.test.sh: unsupported arch: $(uname -m)" >&2
    exit 1
    ;;
esac

BINARY="tret-$OS-$ARCH"
ARCHIVE="$BINARY.tar.gz"
[ -f "$DIST/$ARCHIVE" ] || {
  echo "install.test.sh: missing $DIST/$ARCHIVE - run scripts/build.sh $OS-$ARCH first" >&2
  exit 1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAKE_HOME="$WORK/home"
SHIM="$WORK/bin"
RELEASE="$WORK/release"
mkdir -p "$FAKE_HOME" "$SHIM" "$RELEASE"
cp "$DIST/checksums.txt" "$RELEASE/checksums.txt"
cp "$DIST/$ARCHIVE" "$RELEASE/$ARCHIVE"
printf '[{"tag_name":"v0.0.0-test"}]' >"$RELEASE/releases.json"

# The shim maps the three URLs install.sh fetches to local files; every other
# URL is a test failure, so an unexpected fetch cannot silently pass.
cat >"$SHIM/curl" <<SHIM_EOF
#!/usr/bin/env bash
out=""
url=""
while [ "\$#" -gt 0 ]; do
  case "\$1" in
    -o) out="\$2"; shift 2 ;;
    -*) shift ;;
    *) url="\$1"; shift ;;
  esac
done
case "\$url" in
  *api.github.com*) file="$RELEASE/releases.json" ;;
  */checksums.txt) file="$RELEASE/checksums.txt" ;;
  *"/$ARCHIVE") file="$RELEASE/$ARCHIVE" ;;
  *) echo "curl shim: unexpected url \$url" >&2; exit 22 ;;
esac
if [ -n "\$out" ]; then cp "\$file" "\$out"; else cat "\$file"; fi
SHIM_EOF
chmod +x "$SHIM/curl"

run_install() { HOME="$FAKE_HOME" PATH="$SHIM:$PATH" bash "$ROOT/scripts/install.sh" "$@"; }

fail() {
  echo "install.test.sh: FAIL: $1" >&2
  exit 1
}

# First run installs the binary and the ~/.local/bin symlink.
run_install >/dev/null
[ -x "$FAKE_HOME/.tret/bin/tret" ] || fail "binary not installed as executable"
[ -L "$FAKE_HOME/.local/bin/tret" ] || fail "symlink not created"
[ "$(readlink "$FAKE_HOME/.local/bin/tret")" = "$FAKE_HOME/.tret/bin/tret" ] || fail "symlink points elsewhere"

# Second run recognizes the verified binary and skips the reinstall.
SECOND="$(run_install)"
case "$SECOND" in
  *"already up to date"*) ;;
  *) fail "second run did not report up to date: $SECOND" ;;
esac

# A corrupted archive must fail verification instead of being installed.
rm "$FAKE_HOME/.tret/bin/tret"
printf 'not a tarball' >"$RELEASE/$ARCHIVE"
if run_install >/dev/null 2>&1; then
  fail "corrupted archive was accepted"
fi
[ ! -e "$FAKE_HOME/.tret/bin/tret" ] || fail "corrupted archive left a binary behind"

echo "install.test.sh: OK for $BINARY"
