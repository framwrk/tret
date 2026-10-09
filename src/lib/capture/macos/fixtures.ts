import { chmodSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import type { AbsolutePath } from "../../../types";
import { join } from "node:path";

/**
 * The macOS fallback integration fixture: a small pre-existing scope plus a scripted install. It
 * exercises every event the fallback can infer — create, write, chmod, unlink, mkdir, and symlink —
 * with sizes that differ on every edit so the stamp change the backend relies on is unambiguous.
 *
 * The two halves are separate so a test can snapshot the scope, run `applyFixtureInstall`, then stop.
 */

/** Files and directories the fixture references, relative to the scope root. */
export const FIXTURE = {
  configFile: ".config/tool.conf",
  binary: ".mytool/bin/mytool",
  secondBinary: ".mytool/bin/mytool2",
  removedFile: ".mytool/removed.txt",
  shareDir: ".mytool/share/doc",
  readme: ".mytool/share/doc/README",
  symlinkDir: ".local/bin",
  symlink: ".local/bin/mytool",
} as const;

/** Writes the pre-existing scope an install starts from. */
export function buildFixtureScope(scope: AbsolutePath): void {
  mkdirSync(join(scope, ".config"), { recursive: true });
  mkdirSync(join(scope, ".mytool/bin"), { recursive: true });
  writeFileSync(join(scope, FIXTURE.configFile), "config-v1\n");
  writeFileSync(join(scope, FIXTURE.binary), "binary-v1\n");
  chmodSync(join(scope, FIXTURE.binary), 0o644);
  writeFileSync(join(scope, FIXTURE.removedFile), "remove me\n");
}

/** Runs the fixture install: edit, delete, chmod, create nested, create, and symlink. */
export function applyFixtureInstall(scope: AbsolutePath): void {
  writeFileSync(join(scope, FIXTURE.configFile), "config-version-two\n");
  unlinkSync(join(scope, FIXTURE.removedFile));
  chmodSync(join(scope, FIXTURE.binary), 0o755);
  mkdirSync(join(scope, FIXTURE.shareDir), { recursive: true });
  writeFileSync(join(scope, FIXTURE.readme), "docs\n");
  writeFileSync(join(scope, FIXTURE.secondBinary), "binary-v2\n");
  mkdirSync(join(scope, FIXTURE.symlinkDir), { recursive: true });
  symlinkSync(join(scope, FIXTURE.binary), join(scope, FIXTURE.symlink));
}
