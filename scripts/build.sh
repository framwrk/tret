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
# Bun cross-compiles each target, so one host can produce the whole matrix; the
# binaries are still native on the platform the archive lands on.
set -euo pipefail

ALL_TARGETS=("darwin-arm64" "darwin-x64" "linux-arm64" "linux-x64")

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
  COPYFILE_DISABLE=1 tar -czf "$DIST/tret-$os-$arch.tar.gz" -C "$stage" tret
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
