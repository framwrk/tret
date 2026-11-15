import { expect, test } from "bun:test";
import type { CaptureBackend } from "./capture/backend";
import type { Journal } from "./capture/events";
import { runBoundedSession } from "./session";

const prefix: Journal = {
  backend: "stream",
  completeness: "partial",
  partialReason: "live prefix",
  events: [{ type: "create", path: "/scope/tool", after: { kind: "file", mode: 0o755 }, seq: 0, at: 1 }],
};
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("a failed close retains a live prefix and reports capture failure after running once", async () => {
  let runs = 0;
  const saved: Journal[] = [];
  const beforeImages = new Map([["a".repeat(64), new Uint8Array([1, 2, 3])]]);
  const backend: CaptureBackend = {
    name: "stream",
    completeness: "complete",
    start: async () => ({
      backend: "stream",
      beforeImages,
      checkpoint: async () => prefix,
      stop: async () => {
        throw new Error("close failed");
      },
    }),
  };
  const result = await runBoundedSession({
    backend,
    pid: 1,
    roots: ["/scope"],
    privilege: "user",
    checkpointIntervalMs: 1,
    onCheckpoint: async (journal) => {
      saved.push(journal);
    },
    run: async () => {
      runs++;
      await delay(25);
      return 0;
    },
  });
  expect(saved.length).toBe(1);
  expect(result.journal.events).toEqual(prefix.events);
  expect(result.captureError).toBeInstanceOf(Error);
  expect(result.journal.beforeImages).toEqual(beforeImages);
  expect(result.journal.partialReason).toContain("close failed");
  expect(runs).toBe(1);
});

test("a failed live persistence callback never reruns work or overlaps close", async () => {
  let runs = 0;
  let callbacks = 0;
  let closed = false;
  const backend: CaptureBackend = {
    name: "stream",
    completeness: "complete",
    start: async () => ({
      backend: "stream",
      checkpoint: async () => prefix,
      stop: async () => {
        closed = true;
        return { ...prefix, completeness: "complete", partialReason: undefined };
      },
    }),
  };
  const result = await runBoundedSession({
    backend,
    pid: 1,
    roots: ["/scope"],
    privilege: "user",
    checkpointIntervalMs: 1,
    onCheckpoint: async () => {
      callbacks++;
      expect(closed).toBe(false);
      throw new Error("checkpoint ENOSPC");
    },
    run: async () => {
      runs++;
      await delay(25);
      return 0;
    },
  });
  expect(callbacks).toBe(1);
  expect(closed).toBe(true);
  expect(result.journal.completeness).toBe("partial");
  expect(result.captureError).toBeInstanceOf(Error);
  expect(result.journal.partialReason).toContain("checkpoint ENOSPC");
  expect(runs).toBe(1);
});

test("close joins a pending durable callback before reading the final journal", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let committed = false;
  const backend: CaptureBackend = {
    name: "stream",
    completeness: "complete",
    start: async () => ({
      backend: "stream",
      checkpoint: async () => prefix,
      stop: async () => {
        expect(committed).toBe(true);
        return prefix;
      },
    }),
  };
  await runBoundedSession({
    backend,
    pid: 1,
    roots: [],
    privilege: "user",
    checkpointIntervalMs: 1,
    onCheckpoint: async () => {
      entered();
      await delay(10);
      committed = true;
    },
    run: async () => {
      await started;
    },
  });
});

test("automatic publication stops at 32 prefixes and final close still runs", async () => {
  let count = 0;
  let sampled = 0;
  let close = 0;
  let capped!: () => void;
  const ready = new Promise<void>((resolve) => {
    capped = resolve;
  });
  const backend: CaptureBackend = {
    name: "stream",
    completeness: "complete",
    start: async () => ({
      backend: "stream",
      checkpoint: async () => ({ ...prefix, partialReason: String(++sampled) }),
      stop: async () => {
        close++;
        return { ...prefix, completeness: "complete", partialReason: undefined };
      },
    }),
  };
  const result = await runBoundedSession({
    backend,
    pid: 1,
    roots: [],
    privilege: "user",
    checkpointIntervalMs: 1,
    onCheckpoint: async () => {
      if (++count === 32) capped();
    },
    run: async () => {
      await ready;
      await delay(10);
    },
  });
  expect(count).toBe(32);
  expect(sampled).toBe(32);
  expect(close).toBe(1);
  expect(result.captureError).toBeUndefined();
  expect(result.journal.completeness).toBe("complete");
});

test("the checkpoint timestamp precedes asynchronous prefix sampling", async () => {
  let clock = 100;
  const timestamps: string[] = [];
  const backend: CaptureBackend = {
    name: "stream",
    completeness: "complete",
    start: async () => ({
      backend: "stream",
      checkpoint: async () => {
        clock = 200;
        return prefix;
      },
      stop: async () => prefix,
    }),
  };
  await runBoundedSession({
    backend,
    pid: 1,
    roots: [],
    privilege: "user",
    checkpointIntervalMs: 1,
    now: () => clock,
    onCheckpoint: async (_journal, observedAt) => {
      timestamps.push(observedAt);
    },
    run: async () => {
      await delay(10);
    },
  });
  expect(timestamps).toEqual([new Date(100).toISOString()]);
});

test("a close that omits earlier observations retains them and reports partial failure", async () => {
  const backend: CaptureBackend = {
    name: "stream",
    completeness: "complete",
    start: async () => ({
      backend: "stream",
      checkpoint: async () => prefix,
      stop: async () => ({ backend: "stream", completeness: "complete", events: [] }),
    }),
  };
  const result = await runBoundedSession({
    backend,
    pid: 1,
    roots: [],
    privilege: "user",
    checkpointIntervalMs: 1,
    onCheckpoint: async () => {},
    run: async () => {
      await delay(10);
    },
  });
  expect(result.journal.events).toEqual(prefix.events);
  expect(result.journal.completeness).toBe("partial");
  expect(result.captureError).toBeInstanceOf(Error);
});
