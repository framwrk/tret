import { LINUX_PLATFORM, MACOS_PLATFORM, observationRoots } from "../../platform";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { MacosHeuristicCaptureBackend } from "./backend";
import { join } from "node:path";
import { macosHeuristicRoots } from "./scope";
import { macosHomeRootBounds } from "./homeScope";
import { normalizeJournal } from "../../journal/normalize";
import { tmpdir } from "node:os";

// Defect #3: a macOS installer can drop a dotfile or dot-directory directly at `$HOME`
// (`~/.claude.json`, `~/.claude/`). The heuristic scope now observes `$HOME` top level, bounded by
// the shared skip rules, so those paths are captured without turning the root into a global scan.

const NO_BACKUPS = { enabled: false, sizeLimitBytes: 1024 * 1024 };

describe("macOS home root scope (defect #3)", () => {
  test("$HOME is an observation root for macOS only", () => {
    expect(MACOS_PLATFORM.captureHomeRoot).toBe(true);
    expect(LINUX_PLATFORM.captureHomeRoot).toBeUndefined();

    expect(macosHeuristicRoots({ home: "/Users/tester" })).toContain("/Users/tester");
    expect(observationRoots(LINUX_PLATFORM, { home: "/home/tester" })).not.toContain("/home/tester");
  });

  test("the home bounds reuse the shared skip rules", () => {
    const bounds = macosHomeRootBounds("/Users/tester");
    expect(bounds.excludePaths?.has("/Users/tester/Library")).toBe(true);
    expect(bounds.excludePaths?.has("/Users/tester/Downloads")).toBe(true);
    expect(bounds.excludePaths?.has("/Users/tester/.hermes/state.db-wal")).toBe(true);
    expect(bounds.excludeDirNames?.has("node_modules")).toBe(true);
    expect(bounds.excludeDirNamePattern?.test("_cacache")).toBe(true);
  });

  test("records top-level dotfiles and dot-directories, and prunes excluded home paths", async () => {
    const home = mkdtempSync(join(tmpdir(), "tret-home-scope-"));
    try {
      const backend = new MacosHeuristicCaptureBackend({ home });
      const session = await backend.start({ pid: process.pid, privilege: "user", roots: [home] });

      writeFileSync(join(home, ".toolrc"), "tool\n");
      mkdirSync(join(home, ".tool/bin"), { recursive: true });
      writeFileSync(join(home, ".tool/bin/tool"), "#!/bin/sh\n");

      // Created during the window under paths the home root must not descend into. `Library/Logs`
      // is deliberately included: the home walk prunes `~/Library`, so the explicit `~/Library/*`
      // capture roots remain the only Library access (defect #2 owns those roots).
      for (const excluded of ["Library/Logs", "node_modules", "Downloads", "Documents"]) {
        mkdirSync(join(home, excluded), { recursive: true });
        writeFileSync(join(home, excluded, "x"), "x\n");
      }

      const journal = await session.stop();
      const owned = normalizeJournal({
        journal,
        backups: NO_BACKUPS,
        caseSensitive: backend.caseSensitive,
      }).owned.map((entry) => entry.path);

      expect(owned).toContain(join(home, ".toolrc"));
      expect(owned).toContain(join(home, ".tool"));
      expect(owned).toContain(join(home, ".tool/bin/tool"));
      for (const excluded of ["Library/Logs/x", "node_modules/x", "Downloads/x", "Documents/x"]) {
        expect(owned).not.toContain(join(home, excluded));
      }
      expect(journal.events.some((event) => "path" in event && event.path.includes("/Library/"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("existing subdir roots are scanned whole, so name exclusions do not apply to them", async () => {
    const home = mkdtempSync(join(tmpdir(), "tret-home-subdir-"));
    try {
      const config = join(home, ".config");
      const bin = join(home, ".local/bin");
      mkdirSync(join(config, "node_modules"), { recursive: true });
      mkdirSync(bin, { recursive: true });

      const backend = new MacosHeuristicCaptureBackend({ home });
      const session = await backend.start({ pid: process.pid, privilege: "user", roots: [config, bin] });

      writeFileSync(join(config, "node_modules/x"), "x\n");
      writeFileSync(join(bin, "tool"), "#!/bin/sh\n");

      const journal = await session.stop();
      const owned = normalizeJournal({
        journal,
        backups: NO_BACKUPS,
        caseSensitive: backend.caseSensitive,
      }).owned.map((entry) => entry.path);

      // These roots are not the home root, so the home bounds never apply: `node_modules` is scanned.
      expect(owned).toContain(join(config, "node_modules/x"));
      expect(owned).toContain(join(bin, "tool"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
