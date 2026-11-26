import { MemoryBaseline, RealFsInspector, captureBaseline } from "./linux/inspect";
import { afterEach, expect, test } from "bun:test";
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { diffScopedSnapshots, readFileBytes } from "./macos/scoped";
import type { ScopedSnapshot } from "./macos/scoped";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tret-resource-safety-"));
  roots.push(root);
  return root;
}

test("a large created binary receives a streamed fingerprint beyond the old 64 MiB gap", async () => {
  const file = join(fixture(), "large-binary");
  const length = 65 * 1024 * 1024 + 17;
  const fd = openSync(file, "wx", 0o755);
  try {
    ftruncateSync(fd, length);
  } finally {
    closeSync(fd);
  }
  const hasher = new Bun.CryptoHasher("sha256");
  const zeros = new Uint8Array(64 * 1024);
  for (let remaining = length; remaining > 0; remaining -= zeros.byteLength)
    hasher.update(zeros.subarray(0, Math.min(remaining, zeros.byteLength)));
  const actual = await new RealFsInspector().inspect(file);
  expect(actual.kind).toBe("file");
  expect("hash" in actual ? actual.hash : undefined).toBe(hasher.digest("hex"));
});

test("backup reads enforce an actual returned-byte limit", async () => {
  const file = join(fixture(), "config");
  writeFileSync(file, "a".repeat(64));
  const bytes = await readFileBytes(file, { maxBytes: 16 });
  expect(bytes?.byteLength).toBeUndefined();
});

test("an unsupported node is unknown, never an absent baseline node", async () => {
  const info = await new RealFsInspector().inspect("/dev/null", { hash: false });
  expect(info.kind).toBe("unknown");
});

test("home-relative exclusions do not blind an unrelated explicit root", async () => {
  const scope = fixture();
  const file = join(scope, "Documents", "tool.conf");
  mkdirSync(join(scope, "Documents"));
  writeFileSync(file, "configuration");
  const { baseline } = await captureBaseline([scope]);
  expect(baseline.existed(file)).toBe(true);
});

function snapshots(): { known: ScopedSnapshot; uncertain: ScopedSnapshot } {
  return {
    known: {
      entries: new Map([["/scope/file", { path: "/scope/file", kind: "file", size: 1, mtimeMs: 1, inode: 1, mode: 0o600 }]]),
      errors: [],
    },
    uncertain: { entries: new Map(), errors: ["/scope: unreadable"] },
  };
}
test("an unreadable before-scan does not prove a later observation was created", () => {
  const { known, uncertain } = snapshots();
  const events = diffScopedSnapshots(uncertain, known);
  expect(events.some((event) => event.type === "create")).toBe(false);
  expect(events.some((event) => event.type === "observation" && event.reason === "baseline-unknown")).toBe(true);
});
test("an unreadable after-scan does not prove a known file was deleted", () => {
  const { known, uncertain } = snapshots();
  expect(diffScopedSnapshots(known, uncertain)).toEqual([]);
});

test("baseline absence requires an enumerated parent or a known missing root", () => {
  const baseline = new MemoryBaseline([
    ["/scope", "directory"],
    ["/scope/cache", "directory"],
  ]);
  expect(baseline.state("/scope/new")).toBe("unknown");
  baseline.complete("/scope");
  expect(baseline.state("/scope/new/child")).toBe("absent");
  expect(baseline.state("/scope/cache/hidden")).toBe("unknown");
  baseline.exclude("/scope/Documents");
  expect(baseline.state("/scope/Documents/file")).toBe("unknown");
  baseline.unknown("/scope/unreadable", "permission denied");
  expect(baseline.state("/scope/unreadable/file")).toBe("unknown");
  baseline.missing("/missing-root");
  expect(baseline.state("/missing-root/file")).toBe("absent");
  expect(baseline.snapshot()).toContainEqual({ path: "/missing-root", kind: "unknown", presence: "absent" });
});
