import { FakeFsInspector, RealFsInspector } from "./inspect";
import { LinuxCaptureBackend, fanotifyHelperPath, isRoot, parentAttachRestricted } from "./backend";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type { CaptureSession } from "../backend";
import { FakeLinuxTracer } from "./fake";
import type { TracerAttachOptions } from "./tracer";
import { join } from "node:path";
import { normalizeJournal } from "../../journal/normalize";
import { tmpdir } from "node:os";

const DEFAULT_TRACER_PREFLIGHT_TEST_ENABLED =
  process.platform === "linux" &&
  !(isRoot() && fanotifyHelperPath() !== undefined) &&
  (parentAttachRestricted() || Bun.which("strace") === null);

class CountingFsInspector extends RealFsInspector {
  inspected = 0;

  override inspect(...args: Parameters<RealFsInspector["inspect"]>) {
    this.inspected++;
    return super.inspect(...args);
  }
}

function backendWith(tracer: FakeLinuxTracer, options: { processAlive?: (pid: number) => boolean } = {}) {
  const seen: TracerAttachOptions[] = [];
  const backend = new LinuxCaptureBackend({
    tracerFactory: async (options) => {
      seen.push(options);
      return tracer;
    },
    inspector: new FakeFsInspector([["/h/d", { kind: "directory" }]]),
    baseline: "none",
    settleMs: 10,
    ...(options.processAlive === undefined ? {} : { processAlive: options.processAlive }),
  });
  return { backend, seen };
}

async function capture(backend: LinuxCaptureBackend, pid = 42): Promise<CaptureSession> {
  return backend.start({ pid, privilege: "user", roots: ["/h"] });
}

describe("linux capture backend", () => {
  test.skipIf(!DEFAULT_TRACER_PREFLIGHT_TEST_ENABLED)(
    "rejects an unavailable default tracer before reading the backup baseline",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "tret-backend-preflight-"));
      writeFileSync(join(root, "config"), "original\n");
      const inspector = new CountingFsInspector();

      try {
        const backend = new LinuxCaptureBackend({ inspector });
        await expect(
          backend.start({
            pid: process.pid,
            privilege: "user",
            roots: [root],
            backups: { enabled: true, sizeLimitBytes: 1024 },
          }),
        ).rejects.toThrow(/strace|ptrace/i);
        expect(inspector.inspected).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("delegates attach options and reports a complete journal for a clean window", async () => {
    const tracer = new FakeLinuxTracer({ name: "linux-fanotify" });
    tracer.push({ op: "mkdir", at: 1, pid: 42, path: "/h/d" });
    const { backend, seen } = backendWith(tracer);

    const session = await capture(backend);
    const journal = await session.stop();

    expect(seen).toEqual([{ pid: 42, roots: ["/h"] }]);
    expect(session.backend).toBe("linux-fanotify");
    expect(journal.backend).toBe("linux-fanotify");
    expect(journal.completeness).toBe("complete");
    expect(journal.partialReason).toBeUndefined();
    expect(journal.events.map((event) => event.type)).toEqual(["mkdir"]);
  });

  test("a tracer loss reason downgrades the journal to partial", async () => {
    const tracer = new FakeLinuxTracer().addLoss("strace could not attach: Operation not permitted");
    const { backend } = backendWith(tracer);
    const journal = await (await capture(backend)).stop();

    expect(journal.completeness).toBe("partial");
    expect(journal.partialReason).toContain("Operation not permitted");
  });

  test("an unsupported syscall downgrades the journal to partial", async () => {
    const tracer = new FakeLinuxTracer().push({
      op: "unsupported",
      at: 1,
      pid: 42,
      syscall: "mmap",
      reason: "memory-mapped file changes are not visible to the journal",
    });
    const { backend } = backendWith(tracer);
    const journal = await (await capture(backend)).stop();

    expect(journal.completeness).toBe("partial");
    expect(journal.partialReason).toContain("unsupported syscalls");
    expect(journal.partialReason).toContain("mmap");
  });

  test("a parser diagnostic downgrades the journal to partial", async () => {
    const tracer = new FakeLinuxTracer().diagnose("relative path with no known directory: sub/f");
    const { backend } = backendWith(tracer);
    const journal = await (await capture(backend)).stop();

    expect(journal.completeness).toBe("partial");
    expect(journal.partialReason).toContain("relative path");
  });

  test("a resolved-root escape downgrades the journal to partial", async () => {
    const tracer = new FakeLinuxTracer().push({ op: "mkdir", at: 1, pid: 42, path: "/h/link/out" });
    const backend = new LinuxCaptureBackend({
      tracerFactory: async () => tracer,
      inspector: new FakeFsInspector().setResolution("/h/link", "/away"),
      baseline: "none",
      settleMs: 10,
    });

    const journal = await (await capture(backend)).stop();

    expect(journal.events).toEqual([]);
    expect(journal.completeness).toBe("partial");
    expect(journal.partialReason).toContain("/h/link/out");
  });

  test("a descendant still alive at stop means live descendants and is never complete", async () => {
    const tracer = new FakeLinuxTracer({ active: true });
    tracer.push({ op: "mkdir", at: 1, pid: 99, path: "/h/d" });
    const { backend } = backendWith(tracer, { processAlive: (pid) => pid === 99 });
    const journal = await (await capture(backend)).stop();

    expect(journal.completeness).toBe("partial");
    expect(journal.partialReason).toContain("live descendants");
  });

  test("a tracer still attached to the observed root alone stays complete", async () => {
    const tracer = new FakeLinuxTracer({ active: true });
    tracer.push({ op: "mkdir", at: 1, pid: 42, path: "/h/d" });
    tracer.push({ op: "write", at: 2, pid: 7, path: "/h/d/f" });
    const { backend } = backendWith(tracer, { processAlive: (pid) => pid === 42 });
    const journal = await (await capture(backend)).stop();

    // The root (pid 42) is the caller's own process, alive by construction; the descendant that did
    // the work (pid 7) exited, so nothing outlived the window.
    expect(journal.completeness).toBe("complete");
    expect(journal.partialReason).toBeUndefined();
  });

  test("records outside the roots are dropped even if the tracer reports them", async () => {
    const tracer = new FakeLinuxTracer();
    tracer.push({ op: "mkdir", at: 1, pid: 42, path: "/h/d" });
    tracer.push({ op: "mkdir", at: 2, pid: 42, path: "/elsewhere/x" });
    const { backend } = backendWith(tracer);
    const journal = await (await capture(backend)).stop();

    expect(journal.events.map((event) => (event.type === "mkdir" ? event.path : ""))).toEqual(["/h/d"]);
  });
});

describe("linux capture backend: before-images", () => {
  test("captures pre-existing bytes and threads them into the journal when backups are enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "tret-backend-backup-"));
    try {
      const config = join(root, "config");
      writeFileSync(config, "original\n");
      chmodSync(config, 0o640);

      const tracer = new FakeLinuxTracer();
      const backend = new LinuxCaptureBackend({ tracerFactory: async () => tracer, settleMs: 10 });
      const backups = { enabled: true, sizeLimitBytes: 1024 };
      const session = await backend.start({ pid: 42, privilege: "user", roots: [root], backups });

      // The installer overwrites the file; the fake tracer reports the write it performed.
      writeFileSync(config, "installed\n");
      tracer.push({ op: "write", at: 1, pid: 7, path: config });
      const journal = await session.stop();

      const originalHash = new Bun.CryptoHasher("sha256").update("original\n").digest("hex");
      const installedHash = new Bun.CryptoHasher("sha256").update("installed\n").digest("hex");
      const before = journal.events.find((event) => event.type === "write")?.before;
      expect(before).toEqual({ kind: "file", hash: originalHash, size: 9, mode: 0o640, mtimeMs: expect.any(Number) });
      expect(new TextDecoder().decode(journal.beforeImages?.get(originalHash))).toBe("original\n");

      // End to end: the captured bytes gate the record's restore claim.
      const effects = normalizeJournal({
        journal,
        backups,
        caseSensitive: true,
        availableBeforeImages: new Set(journal.beforeImages?.keys() ?? []),
      });
      expect(effects.mutated).toEqual([
        { path: config, beforeHash: originalHash, installedHash, mode: 0o640, beforeBlob: originalHash },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("captures nothing when the window has no backup policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "tret-backend-nobackup-"));
    try {
      const config = join(root, "config");
      writeFileSync(config, "original\n");

      const tracer = new FakeLinuxTracer();
      const backend = new LinuxCaptureBackend({ tracerFactory: async () => tracer, settleMs: 10 });
      const session = await backend.start({ pid: 42, privilege: "user", roots: [root] });

      writeFileSync(config, "installed\n");
      tracer.push({ op: "write", at: 1, pid: 7, path: config });
      const journal = await session.stop();

      expect(journal.beforeImages).toBeUndefined();
      const write = journal.events.find((event) => event.type === "write");
      expect(write?.type === "write" ? write.before : undefined).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("fanotify helper discovery", () => {
  function executableHelper(dir: string): string {
    const helper = join(dir, "tret-fanotify");
    writeFileSync(helper, "");
    chmodSync(helper, 0o755);
    return helper;
  }

  test("finds the helper shipped next to the running binary", () => {
    const dir = mkdtempSync(join(tmpdir(), "tret-helper-"));
    const helper = executableHelper(dir);

    expect(fanotifyHelperPath({}, join(dir, "tret"), undefined)).toBe(helper);
  });

  test("prefers an explicit TRET_FANOTIFY override", () => {
    const dir = mkdtempSync(join(tmpdir(), "tret-helper-"));
    const helper = executableHelper(dir);

    expect(fanotifyHelperPath({ TRET_FANOTIFY: helper }, "/nope/tret", undefined)).toBe(helper);
  });

  test("falls back to the installed-binary directory for a dev run", () => {
    const home = mkdtempSync(join(tmpdir(), "tret-helper-"));
    const bin = join(home, ".tret/bin");
    mkdirSync(bin, { recursive: true });
    const helper = join(bin, "tret-fanotify");
    writeFileSync(helper, "");
    chmodSync(helper, 0o755);

    expect(fanotifyHelperPath({}, "/nope/tret", home)).toBe(helper);
  });

  test("returns undefined for a missing or non-executable helper", () => {
    const dir = mkdtempSync(join(tmpdir(), "tret-helper-"));
    const plain = join(dir, "tret-fanotify");
    writeFileSync(plain, "");
    chmodSync(plain, 0o644);

    expect(fanotifyHelperPath({}, "/nope/tret", undefined)).toBeUndefined();
    expect(fanotifyHelperPath({ TRET_FANOTIFY: plain }, "/nope/tret", undefined)).toBeUndefined();
  });
});
