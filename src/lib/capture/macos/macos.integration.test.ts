import { FIXTURE, applyFixtureInstall, buildFixtureScope } from "./fixtures";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { MacosHeuristicCaptureBackend } from "./backend";
import { hashFile } from "./scoped";
import { join } from "node:path";
import { normalizeJournal } from "../../journal/normalize";
import { tmpdir } from "node:os";

const NO_BACKUPS = { enabled: false, sizeLimitBytes: 1024 * 1024 };

describe("macOS heuristic backend (integration fixture)", () => {
  test("a fixture install produces the expected journal and normalized effects", async () => {
    const root = mkdtempSync(join(tmpdir(), "tret-macos-"));
    try {
      const scope = join(root, "scope");
      buildFixtureScope(scope);

      const backend = new MacosHeuristicCaptureBackend();
      const session = await backend.start({ pid: process.pid, privilege: "user", roots: [scope] });
      applyFixtureInstall(scope);
      const journal = await session.stop();

      expect(journal.backend).toBe("macos-heuristic");
      expect(journal.completeness).toBe("heuristic");
      expect(journal.partialReason).toBeUndefined();
      expect(journal.events.map((event) => event.type)).toEqual([
        "unlink",
        "mkdir",
        "mkdir",
        "symlink",
        "create",
        "mkdir",
        "mkdir",
        "create",
        "write",
        "chmod",
      ]);
      expect(journal.events.every((event) => event.pid === undefined)).toBe(true);

      const effects = normalizeJournal({ journal, backups: NO_BACKUPS, caseSensitive: backend.caseSensitive });

      expect(effects.owned.map((entry) => entry.path)).toEqual([
        join(scope, ".local"),
        join(scope, FIXTURE.symlinkDir),
        join(scope, FIXTURE.symlink),
        join(scope, FIXTURE.secondBinary),
        join(scope, ".mytool/share"),
        join(scope, FIXTURE.shareDir),
        join(scope, FIXTURE.readme),
      ]);
      expect(effects.owned.find((entry) => entry.path === join(scope, FIXTURE.symlink))?.linkTarget).toBe(
        join(scope, FIXTURE.binary),
      );
      expect(effects.owned.find((entry) => entry.path === join(scope, FIXTURE.readme))?.installedHash).toBe(
        await hashFile(join(scope, FIXTURE.readme)),
      );
      expect(effects.owned.find((entry) => entry.path === join(scope, FIXTURE.secondBinary))?.installedHash).toBe(
        await hashFile(join(scope, FIXTURE.secondBinary)),
      );

      expect(effects.mutated.map((entry) => entry.path)).toEqual([
        join(scope, FIXTURE.configFile),
        join(scope, FIXTURE.binary),
      ]);
      expect(effects.mutated.find((entry) => entry.path === join(scope, FIXTURE.configFile))?.installedHash).toBe(
        await hashFile(join(scope, FIXTURE.configFile)),
      );
      expect(effects.deleted.map((entry) => entry.path)).toEqual([join(scope, FIXTURE.removedFile)]);

      expect(effects.diagnostics.some((diagnostic) => diagnostic.code === "coverage")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
