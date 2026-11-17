import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { OperationLog } from "./operation-log";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withOperationLease } from "./operation-lease";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const capture = {
  backend: "linux-strace",
  completeness: "partial" as const,
  events: [
    {
      type: "rename" as const,
      seq: 0,
      at: 1,
      from: "/h/a",
      to: "/h/b",
      semantics: "exchange" as const,
      sourceAfter: { kind: "unknown" as const },
      after: null,
    },
  ],
};

test.each(["bare", "envelope"])("new operation semantics are versioned; old %s receipts stay read-only", async (shape) => {
  const root = mkdtempSync(join(tmpdir(), "tret-rename-receipt-"));
  roots.push(root);
  const log = new OperationLog(root);
  await withOperationLease(root, async () => {
    let op = log.begin("trace");
    expect(op.version).toBe(2);
    op = log.checkpoint(op, { stage: "running", capture });
    expect(log.get(op.id)?.capture).toEqual(capture);
    const path = join(log.directory, `${op.id}.json`);
    const envelope = JSON.parse(readFileSync(path, "utf8"));
    envelope.inline.version = 1;
    envelope.bytes = Buffer.byteLength(JSON.stringify(envelope.inline));
    writeFileSync(path, JSON.stringify(envelope));
    expect(() => log.get(op.id)).toThrow("invalid operation evidence");
    const legacy = { ...op, version: 1 as const, capture: undefined };
    writeFileSync(
      path,
      JSON.stringify(
        shape === "bare"
          ? legacy
          : {
              ...envelope,
              inline: legacy,
              bytes: Buffer.byteLength(JSON.stringify(legacy)),
            },
      ),
    );
    const before = readFileSync(path);
    expect(log.get(op.id)).toEqual(legacy);
    expect(readFileSync(path)).toEqual(before);
    const next = log.checkpoint(legacy, { stage: "partial" });
    expect(next.version).toBe(2);
    expect(log.get(next.id)).toEqual(next);
  });
});

test.each(["future semantics", "invalid endpoint selection", "bad sampled metadata"])(
  "malformed v2 rename evidence refuses: %s",
  async (which) => {
    const root = mkdtempSync(join(tmpdir(), "tret-rename-invalid-"));
    roots.push(root);
    const log = new OperationLog(root);
    await withOperationLease(root, async () => {
      const op = log.checkpoint(log.begin("trace"), { stage: "running", capture });
      const path = join(log.directory, `${op.id}.json`);
      const envelope = JSON.parse(readFileSync(path, "utf8")),
        event = envelope.inline.capture.events[0];
      if (which === "future semantics") event.semantics = "future";
      if (which === "invalid endpoint selection") event.inScope = "both";
      if (which === "bad sampled metadata") event.sourceAfter = { kind: "unknown", hash: "a".repeat(64) };
      envelope.bytes = Buffer.byteLength(JSON.stringify(envelope.inline));
      writeFileSync(path, JSON.stringify(envelope));
      const before = readFileSync(path);
      expect(() => log.get(op.id)).toThrow("invalid operation evidence");
      expect(readFileSync(path)).toEqual(before);
    });
  },
);
