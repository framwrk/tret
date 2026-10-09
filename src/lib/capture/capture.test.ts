import type { JournalEventInput, JournalEventType } from "./events";
import { describe, expect, test } from "bun:test";
import { FakeCaptureBackend } from "./fake";

/** One of every event the journal must be able to express, in a plausible install order. */
const EVENTS: JournalEventInput[] = [
  { type: "create", path: "/home/.mytool/bin/mytool", after: { kind: "file", hash: "a".repeat(64) } },
  {
    type: "write",
    path: "/home/.mytool/config",
    before: { kind: "file" },
    after: { kind: "file", hash: "b".repeat(64) },
  },
  {
    type: "rename",
    from: "/home/.mytool/tmp",
    to: "/home/.mytool/bin/mytool2",
    before: { kind: "file" },
    after: { kind: "file" },
  },
  { type: "unlink", path: "/home/.mytool/old", before: { kind: "file" } },
  { type: "chmod", path: "/home/.mytool/bin/mytool", after: { mode: 0o755 } },
  {
    type: "symlink",
    path: "/home/.local/bin/mytool",
    target: "/home/.mytool/bin/mytool",
    after: { kind: "symlink", target: "/home/.mytool/bin/mytool" },
  },
  { type: "mkdir", path: "/home/.mytool/cache", after: { kind: "directory" } },
  { type: "rmdir", path: "/home/.mytool/cache", before: { kind: "directory" } },
];

const EVENT_TYPES: JournalEventType[] = ["create", "write", "rename", "unlink", "chmod", "symlink", "mkdir", "rmdir"];

describe("capture contract", () => {
  test("the journal event union covers every required operation", () => {
    expect(EVENTS.map((event) => event.type)).toEqual(EVENT_TYPES);
  });

  test("the fake backend replays queued events in order with assigned sequence numbers", async () => {
    const backend = new FakeCaptureBackend({
      name: "fake-tracer",
      completeness: "partial",
      partialReason: "uid transition",
    });
    for (const event of EVENTS) backend.push(event);

    const session = await backend.start({ pid: 4242, privilege: "user", roots: ["/home/.mytool"] });
    const journal = await session.stop();

    expect(journal.backend).toBe("fake-tracer");
    expect(journal.completeness).toBe("partial");
    expect(journal.partialReason).toBe("uid transition");
    expect(journal.events.map((event) => event.type)).toEqual(EVENT_TYPES);
    expect(journal.events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(journal.events.every((event) => typeof event.at === "number")).toBe(true);
    expect(backend.starts).toEqual([{ pid: 4242, privilege: "user", roots: ["/home/.mytool"] }]);
  });

  test("a default fake backend is named fake and complete", async () => {
    const backend = new FakeCaptureBackend();
    const journal = await (await backend.start({ pid: 1, privilege: "root", roots: [] })).stop();

    expect(backend.name).toBe("fake");
    expect(journal.completeness).toBe("complete");
    expect(journal.partialReason).toBeUndefined();
    expect(journal.events).toEqual([]);
  });
});
