# Release checklist

Use this checklist before tagging a release. Releases are tagged from `main` after the release PR merges; do not tag a branch or an unmerged commit.

## Before the release PR merges

- [ ] The change is on a feature branch, not `main`.
- [ ] `bun run lint`, `bun run typecheck`, and `bun test` pass locally.
- [ ] CI is green for every supported target: `darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`.
  - Each target builds and runs the install-script check.
  - Linux artifacts include `tret-fanotify`; the install script test verifies it when the release manifest lists one.
- [ ] `README.md`, `tret --help`, `docs/capture/`, the install scripts, and the artifacts agree about supported behavior and limitations.
- [ ] Any known capture limitation or unavailable platform feature is written down where users will see it.

## Build and verify locally

- [ ] `bun run build` succeeds for the release targets.
- [ ] `bash scripts/install.test.sh` passes for the current target. It installs from a temporary home, verifies the checksum, runs the installed binary with `--version`, and proves a stale binary is replaced through the install path `tret update` uses.
- [ ] `bash scripts/verify-release.sh dist` passes where native Linux artifacts are present. Every target's assets are present, checksums match, and each archive contains the binaries `scripts/install.sh` extracts. A cross-build from macOS intentionally has no Linux fanotify helper, so use the CI artifacts or a Linux host for this check.
- [ ] The release notes name any capture gaps relevant to this release, for example a partial-capture fallback or an unsupported platform.

## Tag and publish

- [ ] Confirm the required checks are green. A failing, skipped, or missing target blocks the release unless the reason is explicitly reviewed and recorded in the release notes.
- [ ] The repository owner approves publishing the release.
- [ ] The release commit is on `main` and is the commit being tagged.
- [ ] Tag the commit (`vX.Y.Z`) and push the tag. The release workflow builds every target, verifies the merged artifacts and checksums, and publishes the GitHub release.
- [ ] After publishing, install from the public URL in a temporary home and run `tret --version`; verify the release notes and asset list on GitHub.
