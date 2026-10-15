#!/usr/bin/env bash
# Builds the release artifact matrix for macOS and Linux on arm64 and x64.
#
# With no arguments every supported target is built; pass one or more `os-arch`
# pairs (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`) to build a
# subset. Each target produces three files under dist/:
#
#   tret-<os>-<arch>          the raw compiled binary
#   tret-<os>-<arch>.tar.gz   the archive published in the release
#   checksums.txt             SHA-256 for everything built here
#
# Linux targets additionally build the privileged fanotify capture helper
# (tret-fanotify) and ship it inside the archive beside `tret`, plus a raw
# `tret-fanotify-linux-<arch>` for direct download. The C helper needs Linux
# kernel headers, so a cross-build of a Linux target from another host skips it
# with a warning; the release workflow builds every target on a native runner,
# where the helper is always compiled.
#
# Bun cross-compiles each target, so one host can produce the whole matrix; the
# binaries are still native on the platform the archive lands on.
set -euo pipefail

ALL_TARGETS=("darwin-arm64" "darwin-x64" "linux-arm64" "linux-x64")
HELPER_SOURCE="src/lib/capture/linux/helper/tret-fanotify.c"

if [ "$#" -gt 0 ]; then
  TARGETS=("$@")
else
  TARGETS=("${ALL_TARGETS[@]}")
fi

# A SHA-256 tool available on both platforms: sha256sum ships on Linux, shasum on
# macOS. Both print `<hash>  <file>`, the format the install script verifies.
if command -v sha256sum >/dev/null 2>&1; then
  hash_file() { sha256sum "$@"; }
else
  hash_file() { shasum -a 256 "$@"; }
fi

VERSION="$(git describe --tags --always 2>/dev/null || echo dev)"
DIST="dist"
STAGE_ROOT="$(mktemp -d)"
trap 'rm -rf "$STAGE_ROOT"' EXIT

mkdir -p "$DIST"

for target in "${TARGETS[@]}"; do
  os="${target%-*}"
  arch="${target#*-}"
  case "$os:$arch" in
    darwin:arm64 | darwin:x64 | linux:arm64 | linux:x64) ;;
    *)
      echo "unsupported target: $target (want one of: ${ALL_TARGETS[*]})" >&2
      exit 1
      ;;
  esac

  stage="$STAGE_ROOT/$target"
  mkdir -p "$stage"

  echo "building tret-$os-$arch"
  bun build ./index.ts --compile --target="bun-$os-$arch" --outfile="$stage/tret" \
    --define "process.env.TRET_VERSION=\"$VERSION\""

  # The raw binary keeps its platform-specific name for checksums and direct
  # downloads; the archive carries a neutral `tret` so extraction is uniform.
  cp "$stage/tret" "$DIST/tret-$os-$arch"

  archive=(tret)
  if [ "$os" = "linux" ]; then
    # The fanotify helper is Linux-only and is discovered beside the `tret`
    # binary at runtime; it needs Linux headers, so it is only built natively.
    if [ "$(uname -s)" = "Linux" ]; then
      echo "building tret-fanotify-linux-$arch"
      ${CC:-cc} -O2 -o "$stage/tret-fanotify" "$HELPER_SOURCE"
      cp "$stage/tret-fanotify" "$DIST/tret-fanotify-linux-$arch"
      archive+=(tret-fanotify)
    else
      echo "note: skipping tret-fanotify for $target (host $(uname -s) cannot build the Linux helper)" >&2
    fi
  fi

  COPYFILE_DISABLE=1 tar -czf "$DIST/tret-$os-$arch.tar.gz" -C "$stage" "${archive[@]}"
done

# Rewrite checksums for exactly the artifacts present, so a subset build never
# leaves stale entries behind. Hash from inside dist/ so the manifest lists bare
# filenames, matching the `<hash>  <name>` lines `scripts/install.sh` verifies.
(
  cd "$DIST"
  for file in tret-*; do
    [ -f "$file" ] || continue
    hash_file "$file"
  done
) | sort -k2 >"$DIST/checksums.txt"

echo "artifacts:"
cat "$DIST/checksums.txt"
