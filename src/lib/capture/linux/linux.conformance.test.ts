import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { BackupPolicy } from "../normalize";
import { FakeFsInspector } from "./inspect";
import { FakeLinuxTracer } from "./fake";
import { LinuxCaptureBackend } from "./backend";
import type { TracerRecord } from "./raw";
import { attachFanotify } from "./tracer";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { normalizeJournal } from "../../journal/normalize";
import { tmpdir } from "node:os";

const FAKE_FANOTIFY = join(fileURLToPath(new URL("./fixtures/", import.meta.url)), "fake-fanotify.sh");
const NO_BACKUPS: BackupPolicy = { enabled: false, sizeLimitBytes: 1024 };

/**
 * One shared tracer-record stream, used to prove that the unprivileged strace-style tracer and the
 * privileged fanotify helper produce the same normalized effects. This is the phase 4 conformance
 * requirement: backends are interchangeable behind the journal shape.
 */
const SHARED_STREAM: TracerRecord[] = [
  { op: "mkdir", at: 1, pid: 42, path: "/h/.local" },
  { op: "mkdir", at: 2, pid: 42, path: "/h/.local/bin" },
  { op: "mkdir", at: 3, pid: 42, path: "/h/.mytool" },
  { op: "mkdir", at: 4, pid: 42, path: "/h/.mytool/bin" },
  { op: "open", at: 5, pid: 42, path: "/h/.mytool/bin/tool", created: true, truncated: true },
  { op: "write", at: 6, pid: 42, path: "/h/.mytool/bin/tool" },
  { op: "symlink", at: 7, pid: 42, path: "/h/.local/bin/tool", target: "/h/.mytool/bin/tool" },
];

const INSPECTOR = new FakeFsInspector([
  ["/h/.local", { kind: "directory" }],
  ["/h/.local/bin", { kind: "directory" }],
  ["/h/.mytool", { kind: "directory" }],
  ["/h/.mytool/bin", { kind: "directory" }],
  ["/h/.mytool/bin/tool", { kind: "file", hash: "a".repeat(64), size: 10 }],
  ["/h/.local/bin/tool", { kind: "symlink", target: "/h/.mytool/bin/tool" }],
]);

function normalize(journal: Awaited<ReturnType<Awaited<ReturnType<LinuxCaptureBackend["start"]>>["stop"]>>) {
  return normalizeJournal({ journal, backups: NO_BACKUPS, caseSensitive: true });
}

describe("linux backend conformance against a shared event stream", () => {
  test("the unprivileged and privileged backends normalize the same stream identically", async () => {
    const tracer = new FakeLinuxTracer({ name: "linux-strace" });
    for (const record of SHARED_STREAM) tracer.push(record);
    const straceBackend = new LinuxCaptureBackend({
      tracerFactory: async () => tracer,
      inspector: INSPECTOR,
      baseline: "none",
      settleMs: 10,
    });
    const straceJournal = await (await straceBackend.start({ pid: 42, privilege: "user", roots: ["/h"] })).stop();

    const dir = await mkdtemp(join(tmpdir(), "tret-fan-conformance-"));
    try {
      const eventsFile = join(dir, "events.ndjson");
      await writeFile(eventsFile, `${SHARED_STREAM.map((record) => JSON.stringify(record)).join("\n")}\n`);
      const fanotifyBackend = new LinuxCaptureBackend({
        tracerFactory: (attach) =>
          attachFanotify(attach, { helperPath: FAKE_FANOTIFY, env: { TRET_FANOTIFY_EVENTS: eventsFile } }),
        inspector: INSPECTOR,
        baseline: "none",
        settleMs: 2000,
      });
      const fanotifyJournal = await (await fanotifyBackend.start({ pid: 42, privilege: "root", roots: ["/h"] })).stop();

      expect(fanotifyJournal.backend).toBe("linux-fanotify");
      expect(fanotifyJournal.completeness).toBe("complete");
      expect(normalize(fanotifyJournal)).toEqual(normalize(straceJournal));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a fanotify helper loss line downgrades the journal to partial", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tret-fan-loss-"));
    try {
      const eventsFile = join(dir, "events.ndjson");
      await writeFile(eventsFile, "");
      const backend = new LinuxCaptureBackend({
        tracerFactory: (attach) =>
          attachFanotify(attach, {
            helperPath: FAKE_FANOTIFY,
            env: { TRET_FANOTIFY_EVENTS: eventsFile, TRET_FANOTIFY_LOSS: "fanotify queue overflowed; events were dropped" },
          }),
        inspector: INSPECTOR,
        baseline: "none",
        settleMs: 2000,
      });
      const journal = await (await backend.start({ pid: 42, privilege: "root", roots: ["/h"] })).stop();

      expect(journal.completeness).toBe("partial");
      expect(journal.partialReason).toContain("queue overflowed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
