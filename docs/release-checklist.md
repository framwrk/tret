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
- [ ] Run the sandboxed Linux acceptance harness at `scripts/linux-acceptance.ts` against the built binary. It uses a temporary `HOME` and loopback fixtures, and it must leave the real `$HOME` and `/etc/profile.d` checksums unchanged. Record the result in the release PR.
- [ ] Confirm the gated production-strace check has a recorded result from an approved disposable host with `ptrace_scope=0` restored afterward, or an explicitly reviewed skip. Never automate the sysctl change.
- [ ] Confirm the privileged run records which backend actually ran (`linux-strace` or `linux-fanotify`). CI runs `scripts/privileged-e2e.sh` on `linux-x64`; a completed flow alone does not prove fanotify attribution.
- [ ] Review the known skips in the [Linux verification record](linux-verification.md) and carry the relevant ones into the release notes.

## Build and verify locally

- [ ] `bash scripts/build.sh` succeeds for all four release targets. The Linux x64 result is recorded in the [Linux verification record](linux-verification.md).
- [ ] `bash scripts/install.test.sh` passes for the current target. It installs from a temporary home, verifies the checksum, runs the installed binary with `--version`, and proves a stale binary is replaced through the install path `tret update` uses.
- [ ] `bash scripts/verify-release.sh dist` passes where native Linux artifacts are present. Every target's assets are present, checksums match, and each archive contains the binaries `scripts/install.sh` extracts. A cross-build from macOS intentionally has no Linux fanotify helper, so use the CI artifacts or a Linux host for this check.
- [ ] The release notes name any capture gaps relevant to this release, for example a partial-capture fallback or an unsupported platform, plus the host-specific skips from the [Linux verification record](linux-verification.md).

## Tag and publish

- [ ] Confirm the required checks are green. A failing, skipped, or missing target blocks the release unless the reason is explicitly reviewed and recorded in the release notes.
- [ ] The repository owner approves publishing the release.
- [ ] The release commit is on `main` and is the commit being tagged.
- [ ] Tag the commit (`vX.Y.Z`) and push the tag. The release workflow builds every target, verifies the merged artifacts and checksums, and publishes the GitHub release.
- [ ] After publishing, install from the public URL in a temporary home and run `tret --version`; verify the release notes and asset list on GitHub.
