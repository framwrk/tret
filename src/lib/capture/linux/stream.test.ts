import { StraceStreamParser, parseStraceOutput } from "./strace";
import { expect, test } from "bun:test";
import { CaptureBudget } from "../budget";
import { FakeFsInspector } from "./inspect";
import { LinuxCaptureBackend } from "./backend";
import type { TracerRecord } from "./raw";

test("byte-fragmented prefixes preserve UTF8, fd maps and resumed calls without finalizing early", () => {
  const text = [
    '10 1.0 openat(AT_FDCWD, "/scope/é", O_WRONLY|O_CREAT|O_EXCL, 0755) = 3',
    '10 2.0 write(3, "data", 4 <unfinished ...>',
    "10 2.1 <... write resumed>) = 4",
    "10 3.0 close(3) = 0",
  ].join("\n");
  const budget = new CaptureBudget();
  const stream = new StraceStreamParser({ roots: ["/scope"], budget });
  const bytes = Buffer.from(text);
  for (const byte of bytes) {
    stream.write(new Uint8Array([byte]));
    expect(stream.snapshot().diagnostics).toEqual([]);
  }
  expect(stream.finish()).toEqual(parseStraceOutput(text, { roots: ["/scope"] }));
  expect(budget.used.auditBytes).toBe(bytes.length);
  expect(budget.used.auditLines).toBe(4);
});

test("a live prefix is not cached as the final trace; only finish diagnoses dangling calls", () => {
  const stream = new StraceStreamParser();
  stream.write(Buffer.from('10 1.0 mkdir("/scope/a", 0700) = 0\n10 2.0 write(3, "x", 1 <unfinished ...>\n'));
  expect(stream.snapshot().records).toHaveLength(1);
  expect(stream.snapshot().diagnostics).toEqual([]);
  stream.write(
    Buffer.from(
      '10 2.1 <... write resumed>) = 1\n10 3.0 mkdir("/scope/b", 0700) = 0\n10 4.0 write(3, "x", 1 <unfinished ...>\n',
    ),
  );
  const final = stream.finish();
  expect(final.records.filter((record) => record.op === "mkdir")).toHaveLength(2);
  expect(final.diagnostics.join(" ")).toContain("never resumed");
});

test("tracer-owned staging is excluded even when /tmp is an observation root", () => {
  const stream = new StraceStreamParser({ roots: ["/tmp"], excludedRoots: ["/tmp/private-audit"] });
  stream.write(
    Buffer.from(
      '10 1.0 openat(AT_FDCWD, "/tmp/private-audit/trace", O_WRONLY|O_CREAT|O_EXCL, 0600) = 3\n10 2.0 mkdir("/tmp/payload", 0700) = 0\n',
    ),
  );
  expect(stream.finish().records).toMatchObject([{ op: "mkdir", path: "/tmp/payload" }]);
});

test("Linux prefixes append only new metadata events; final close hashes the complete window", async () => {
  const inspector = new FakeFsInspector([["/scope/tool", { kind: "file", hash: "a".repeat(64), mode: 0o755 }]]);
  const raw: TracerRecord[] = [{ op: "open", path: "/scope/tool", at: 1, created: true, exclusive: true, truncated: false }];
  const backend = new LinuxCaptureBackend({
    baseline: "none",
    inspector,
    tracerFactory: async () => ({
      name: "linux-strace",
      checkpoint: async () => ({ records: raw.slice(), unsupported: [], diagnostics: [] }),
      records: async () => ({ records: raw.slice(), unsupported: [], diagnostics: [] }),
      status: async () => ({ active: false, tracedDescendants: 0 }),
      losses: () => [],
      stop: async () => {},
    }),
  });
  const session = await backend.start({ pid: 1, roots: ["/scope"], privilege: "user" });
  const first = await session.checkpoint!();
  expect(first?.completeness).toBe("partial");
  expect(first?.events).toHaveLength(1);
  expect(first?.events[0]).toMatchObject({ type: "create", after: { kind: "file" } });
  expect(first?.events[0]).not.toHaveProperty("after.hash");
  expect(await session.checkpoint!()).toBeUndefined();
  raw.push({ op: "write", path: "/scope/tool", at: 2 });
  const second = await session.checkpoint!();
  expect(second?.events.map((event) => event.seq)).toEqual([0, 1]);
  expect(second?.events[1]).toMatchObject({ type: "write", before: undefined });
  const final = await session.stop();
  expect(final.events).toHaveLength(2);
  expect(final.events[0]).toMatchObject({ type: "create", after: { hash: "a".repeat(64) } });
});
