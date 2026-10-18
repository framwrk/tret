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

# The same per-platform hash tool install.sh picks.
if command -v sha256sum >/dev/null 2>&1; then
  HASH() { sha256sum "$@"; }
else
  HASH() { shasum -a 256 "$@"; }
fi

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

# Linux releases ship the fanotify helper beside the binary; when the manifest
# has an entry for it, the install must have put it in place, executable.
HELPER_SHA="$(grep " tret-fanotify-$OS-$ARCH\$" "$RELEASE/checksums.txt" | cut -d' ' -f1 || true)"
if [ -n "$HELPER_SHA" ]; then
  [ -x "$FAKE_HOME/.tret/bin/tret-fanotify" ] || fail "fanotify helper not installed as executable"
  INSTALLED_HELPER_SHA="$(HASH "$FAKE_HOME/.tret/bin/tret-fanotify" | cut -d' ' -f1)"
  [ "$INSTALLED_HELPER_SHA" = "$HELPER_SHA" ] || fail "installed helper does not match the release checksum"
fi

# The installed binary runs and reports the same version as the built artifact.
BUILT_VERSION="$("$DIST/$BINARY" --version 2>&1)"
INSTALLED_VERSION="$("$FAKE_HOME/.tret/bin/tret" --version 2>&1)"
[ -n "$BUILT_VERSION" ] || fail "built artifact reported an empty version"
[ "$INSTALLED_VERSION" = "$BUILT_VERSION" ] || fail "installed binary reported '$INSTALLED_VERSION', expected '$BUILT_VERSION'"

# Second run recognizes the verified binary and skips the reinstall.
SECOND="$(run_install)"
case "$SECOND" in
  *"already up to date"*) ;;
  *) fail "second run did not report up to date: $SECOND" ;;
esac

# A missing helper makes a rerun reinstall the pair instead of reporting up to
# date; the binary and symlink must survive that.
if [ -n "$HELPER_SHA" ]; then
  rm "$FAKE_HOME/.tret/bin/tret-fanotify"
  run_install >/dev/null
  [ -x "$FAKE_HOME/.tret/bin/tret-fanotify" ] || fail "helper was not reinstalled"
  [ -x "$FAKE_HOME/.tret/bin/tret" ] || fail "rerun removed the binary"
  [ -L "$FAKE_HOME/.local/bin/tret" ] || fail "rerun removed the symlink"
fi

# A stale installed binary is replaced by the install script - the same path `tret update`
# uses - and still reports the release version afterward.
printf 'stale binary' >"$FAKE_HOME/.tret/bin/tret"
chmod +x "$FAKE_HOME/.tret/bin/tret"
run_install >/dev/null
EXPECTED_SHA="$(grep " $BINARY\$" "$RELEASE/checksums.txt" | cut -d' ' -f1)"
UPDATED_SHA="$(HASH "$FAKE_HOME/.tret/bin/tret" | cut -d' ' -f1)"
[ "$UPDATED_SHA" = "$EXPECTED_SHA" ] || fail "stale binary was not replaced by the release artifact"
[ "$("$FAKE_HOME/.tret/bin/tret" --version 2>&1)" = "$BUILT_VERSION" ] || fail "updated binary reported the wrong version"

# A corrupted archive must fail verification instead of being installed.
rm "$FAKE_HOME/.tret/bin/tret"
printf 'not a tarball' >"$RELEASE/$ARCHIVE"
if run_install >/dev/null 2>&1; then
  fail "corrupted archive was accepted"
fi
[ ! -e "$FAKE_HOME/.tret/bin/tret" ] || fail "corrupted archive left a binary behind"

echo "install.test.sh: OK for $BINARY"
