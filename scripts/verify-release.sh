#!/usr/bin/env bash
# Verifies the merged release artifact set in dist/ before the release job runs
# `gh release create`: every supported target's assets are present, checksums.txt
# covers and matches each of them, and each archive carries the members
# `scripts/install.sh` extracts. Run `scripts/build.sh` (or the release workflow's
# build job) first.
#
# The target list below mirrors the release workflow's build matrix and the asset
# list its `gh release create` publishes; keep the three in step.
#
# Usage: bash scripts/verify-release.sh [dist-dir]   (default: dist)
set -euo pipefail

DIST="${1:-dist}"
TARGETS=("darwin-arm64" "darwin-x64" "linux-arm64" "linux-x64")

fail() {
  echo "verify-release.sh: FAIL: $1" >&2
  exit 1
}

if command -v sha256sum >/dev/null 2>&1; then
  HASH() { sha256sum "$@"; }
else
  HASH() { shasum -a 256 "$@"; }
fi

[ -d "$DIST" ] || fail "no artifact directory: $DIST"
[ -f "$DIST/checksums.txt" ] || fail "no checksum manifest: $DIST/checksums.txt"

# Every target ships its raw binary and its archive; Linux targets also ship the
# standalone fanotify helper that the release publishes for direct download. The
# install script decides whether a release has a helper from this manifest entry,
# so a release missing it installs no helper at all.
for target in "${TARGETS[@]}"; do
  os="${target%-*}"
  assets=("tret-$target" "tret-$target.tar.gz")
  if [ "$os" = "linux" ]; then
    assets+=("tret-fanotify-$target")
  fi
  for asset in "${assets[@]}"; do
    [ -f "$DIST/$asset" ] || fail "missing asset: $asset"
  done
done

# The manifest and the published files must agree in both directions: a file with
# no entry would ship unverified, and an entry with no file would name an asset
# the release does not carry.
while read -r digest name; do
  [ -n "$digest" ] && [ -n "$name" ] || fail "malformed checksum line: $digest $name"
  [ -f "$DIST/$name" ] || fail "checksums.txt lists missing file: $name"
done <"$DIST/checksums.txt"

for file in "$DIST"/tret-*; do
  name="${file##*/}"
  expected="$(grep " $name\$" "$DIST/checksums.txt" | cut -d' ' -f1 || true)"
  [ -n "$expected" ] || fail "checksums.txt has no entry for $name"
  actual="$(HASH "$file" | cut -d' ' -f1)"
  [ "$expected" = "$actual" ] || fail "checksum mismatch for $name"
done

# install.sh extracts these members from the archive by name; an archive that
# lacks one installs a partial tool even though every published file is intact.
for target in "${TARGETS[@]}"; do
  os="${target%-*}"
  archive="$DIST/tret-$target.tar.gz"
  members="$(tar -tzf "$archive" | sed 's#^\./##')" ||
    fail "unreadable archive: tret-$target.tar.gz"
  printf '%s\n' "$members" | grep -qx "tret" ||
    fail "tret-$target.tar.gz does not contain tret"
  if [ "$os" = "linux" ]; then
    printf '%s\n' "$members" | grep -qx "tret-fanotify" ||
      fail "tret-$target.tar.gz does not contain tret-fanotify"
  fi
done

echo "verify-release.sh: OK - all ${#TARGETS[@]} targets and their checksums verified in $DIST"
