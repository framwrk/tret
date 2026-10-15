import { LinuxCaptureBackend, fanotifyHelperPath } from "./backend";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type { CaptureSession } from "../backend";
import { FakeFsInspector } from "./inspect";
import { FakeLinuxTracer } from "./fake";
import type { TracerAttachOptions } from "./tracer";
import { join } from "node:path";
import { tmpdir } from "node:os";

function backendWith(tracer: FakeLinuxTracer) {
  const seen: TracerAttachOptions[] = [];
  const backend = new LinuxCaptureBackend({
    tracerFactory: async (options) => {
      seen.push(options);
      return tracer;
    },
    inspector: new FakeFsInspector([["/h/d", { kind: "directory" }]]),
    baseline: "none",
    settleMs: 10,
  });
  return { backend, seen };
}

async function capture(backend: LinuxCaptureBackend, pid = 42): Promise<CaptureSession> {
  return backend.start({ pid, privilege: "user", roots: ["/h"] });
}

describe("linux capture backend", () => {
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

  test("a tracer still attached at stop means live descendants and is never complete", async () => {
    const tracer = new FakeLinuxTracer({ active: true });
    const { backend } = backendWith(tracer);
    const journal = await (await capture(backend)).stop();

    expect(journal.completeness).toBe("partial");
    expect(journal.partialReason).toContain("live descendants");
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
