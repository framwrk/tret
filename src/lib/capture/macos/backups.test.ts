import { describe, expect, test } from "bun:test";
import { hashBytes, readFileBytes } from "./scoped";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { MacosHeuristicCaptureBackend } from "./backend";
import { join } from "node:path";
import { normalizeJournal } from "../../journal/normalize";
import { tmpdir } from "node:os";

// Criterion 3 at the capture layer: with backups enabled the macOS fallback reads pre-existing
// content at window start, and normalization claims a restorable before-image only for bytes it
// actually holds. An over-limit or unreadable file stays a detect-only mutation (D2).

describe("macOS heuristic before-image capture (D2)", () => {
  test("captures in-limit content and skips over-limit or unreadable files", async () => {
    const root = mkdtempSync(join(tmpdir(), "tret-before-image-"));
    try {
      const scope = join(root, "scope");
      mkdirSync(scope, { recursive: true });
      const small = join(scope, "small.conf");
      const big = join(scope, "big.conf");
      const secret = join(scope, "secret.conf");
      writeFileSync(small, "small-v1\n");
      writeFileSync(big, "b".repeat(2048));
      writeFileSync(secret, "secret-v1\n");

      const backups = { enabled: true, sizeLimitBytes: 1024 };
      const backend = new MacosHeuristicCaptureBackend({
        // Simulate a file the process cannot read, so no before-image can be captured for it.
        read: async (path) => (path === secret ? undefined : readFileBytes(path)),
      });
      const session = await backend.start({ pid: process.pid, privilege: "user", roots: [scope], backups });

      // Overwrite both configs with new sizes, then delete the unreadable one.
      writeFileSync(small, "small-v2-longer\n");
      writeFileSync(big, "c".repeat(4096));
      unlinkSync(secret);
      const journal = await session.stop();

      const encoder = new TextEncoder();
      const images = journal.beforeImages ?? new Map<string, Uint8Array>();
      expect(images.get(hashBytes(encoder.encode("small-v1\n")))).toEqual(encoder.encode("small-v1\n"));
      expect(images.has(hashBytes(encoder.encode("b".repeat(2048))))).toBe(false);
      expect(images.has(hashBytes(encoder.encode("secret-v1\n")))).toBe(false);

      const effects = normalizeJournal({
        journal,
        backups,
        caseSensitive: true,
        availableBeforeImages: new Set(images.keys()),
      });
      expect(effects.mutated.find((entry) => entry.path === small)?.beforeBlob).toBeDefined();
      expect(effects.mutated.find((entry) => entry.path === big)?.beforeBlob).toBeUndefined();
      expect(effects.deleted.find((entry) => entry.path === secret)?.beforeBlob).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("captures nothing when backups are left off", async () => {
    const root = mkdtempSync(join(tmpdir(), "tret-before-image-off-"));
    try {
      const scope = join(root, "scope");
      mkdirSync(scope, { recursive: true });
      writeFileSync(join(scope, "config"), "v1\n");

      const backend = new MacosHeuristicCaptureBackend();
      const session = await backend.start({ pid: process.pid, privilege: "user", roots: [scope] });
      writeFileSync(join(scope, "config"), "v2-longer\n");
      const journal = await session.stop();

      expect(journal.beforeImages).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
