import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { BackupPolicy } from "../normalize";
import { LinuxCaptureBackend } from "./backend";
import { RealFsInspector } from "./inspect";
import { attachStrace } from "./tracer";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { normalizeJournal } from "../../journal/normalize";
import { tmpdir } from "node:os";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const FAKE_STRACE = join(FIXTURES, "fake-strace.sh");
const FAKE_INSTALLER = join(FIXTURES, "fake-installer.sh");

const NO_BACKUPS: BackupPolicy = { enabled: false, sizeLimitBytes: 1024 * 1024 };

/**
 * Hermetic end-to-end fixture: a fake install script runs under isolated HOME/TMPDIR and its
 * syscall trace is fed through the real `StraceTracer` spawn/parse path, reconstruct, and
 * `normalizeJournal`. It is the reference that validates normalization on a host without Linux.
 */
describe("linux capture backend integration", () => {
  test("captures the fake installer and normalizes it into ownership, mutation and deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "tret-linux-it-"));
    const home = join(root, "home");
    const scratch = join(root, "tmp");
    const marker = join(root, "churn-marker");

    try {
      await mkdir(home, { recursive: true });
      await mkdir(scratch, { recursive: true });
      // Pre-existing paths: `.mytool` (not created), `config` (mutated) and `old` (deleted).
      await mkdir(join(home, ".mytool"), { recursive: true });
      await writeFile(join(home, ".mytool", "config"), "version=1\n");
      await writeFile(join(home, ".mytool", "old"), "old\n");

      const backend = new LinuxCaptureBackend({
        inspector: new RealFsInspector(),
        baseline: "capture",
        settleMs: 3000,
        tracerFactory: (attach) =>
          attachStrace(attach, {
            stracePath: FAKE_STRACE,
            cwd: home,
            detachGraceMs: 3000,
            env: {
              TRET_FAKE_INSTALLER: FAKE_INSTALLER,
              TRET_FIXTURE_HOME: home,
              TRET_FIXTURE_TMPDIR: scratch,
              TRET_FIXTURE_PID: "1000",
              TRET_FIXTURE_TIME: "1700000000",
              TRET_FIXTURE_MARKER: marker,
            },
          }),
      });

      const session = await backend.start({ pid: process.pid, privilege: "user", roots: [home, scratch] });
      await waitFor(() => existsSync(marker));
      const journal = await session.stop();

      expect(journal.backend).toBe("linux-strace");
      expect(journal.completeness).toBe("complete");
      expect(journal.partialReason).toBeUndefined();

      // The out-of-scope marker was traced but is outside the roots, so it is not attributed.
      expect(journal.events.some((event) => JSON.stringify(event).includes(marker))).toBe(false);

      const effects = normalizeJournal({ journal, backups: NO_BACKUPS, caseSensitive: true });
      const tool = join(home, ".mytool", "bin", "tool");
      const link = join(home, ".local", "bin", "tool");

      expect(effects.owned.map((entry) => entry.path)).toEqual([
        join(home, ".local"),
        join(home, ".local", "bin"),
        link,
        join(home, ".mytool", "bin"),
        tool,
      ]);
      expect(effects.owned.find((entry) => entry.path === tool)?.installedHash).toMatch(/^[0-9a-f]{64}$/);
      expect(effects.owned.find((entry) => entry.path === link)?.linkTarget).toBe(tool);
      expect(effects.mutated.map((entry) => entry.path)).toEqual([join(home, ".mytool", "config")]);
      expect(effects.mutated[0]?.installedHash).toMatch(/^[0-9a-f]{64}$/);
      expect(effects.deleted.map((entry) => entry.path)).toEqual([join(home, ".mytool", "old")]);

      const codes = effects.diagnostics.map((diagnostic) => diagnostic.code);
      expect(codes).toContain("temp-rename");
      expect(codes).toContain("create-delete");

      // The transient temp file, the scratch file and the cache directory leave no ownership.
      const owned = new Set(effects.owned.map((entry) => entry.path));
      expect(owned.has(join(scratch, "stage.tool"))).toBe(false);
      expect(owned.has(join(home, ".mytool", "scratch"))).toBe(false);
      expect(owned.has(join(home, ".mytool", "cache"))).toBe(false);
      expect(owned.has(join(home, ".mytool"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("fixture did not finish in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
