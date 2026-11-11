import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { LINUX_PLATFORM } from "./platform";
import type { Platform } from "./platform";
import type { RecordV3 } from "../types";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unverifiedShellEdits } from "./shellconfig";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function testHome(): string {
  const home = mkdtempSync(join(tmpdir(), "tret-shell-policy-"));
  roots.push(home);
  return home;
}

function record(home: string, overrides: Partial<RecordV3> = {}): RecordV3 {
  return {
    id: "rec-1",
    name: "mytool",
    source: "install",
    url: "https://example.com/install.sh",
    installedAt: "2026-10-09T00:00:00.000Z",
    executable: join(home, ".mytool/bin/mytool"),
    scriptSha256: "a".repeat(64),
    capture: {
      backend: "macos-heuristic",
      completeness: "heuristic",
      segments: [{ kind: "install", startedAt: "2026-10-09T00:00:00.000Z" }],
    },
    privilege: "user",
    caseSensitive: true,
    owned: [],
    mutated: [],
    deleted: [],
    ...overrides,
  };
}

/** A platform whose only shell config is an absolute, temporary snippet directory. */
function snippetPlatform(dir: string): Platform {
  return {
    ...LINUX_PLATFORM,
    shellConfigs: [{ shell: "sh", scope: "absolute", path: dir, kind: "directory" }],
  };
}

test("final profile hashes and tool markers cannot establish edit provenance", () => {
  const home = testHome();
  const path = join(home, ".bashrc");
  const target = record(home, { mutated: [{ path, installedHash: "a".repeat(64) }] });
  expect(unverifiedShellEdits(target, LINUX_PLATFORM, home)).toEqual([path]);
});

test("missing and deleted profiles remain unresolved without reading file content", () => {
  const home = testHome();
  const path = join(home, ".bashrc");
  expect(unverifiedShellEdits(record(home, { deleted: [{ path }] }), LINUX_PLATFORM, home)).toEqual([path]);
  expect(unverifiedShellEdits(record(home, { mutated: [{ path }] }), LINUX_PLATFORM, home)).toEqual([path]);
});

test("before-images stay with the ordinary verified file planner, never a line cleaner", () => {
  const home = testHome();
  const path = join(home, ".bashrc");
  expect(unverifiedShellEdits(record(home, { mutated: [{ path, beforeBlob: "a".repeat(64) }] }), LINUX_PLATFORM, home)).toEqual(
    [],
  );
});

test("unrelated configs and similarly named profiles do not become shell scopes", () => {
  const home = testHome();
  const paths = [join(home, ".bashrc.backup"), join(home, ".config/fixture/config"), join(home, "other/.bashrc")];
  expect(unverifiedShellEdits(record(home, { mutated: paths.map((path) => ({ path })) }), LINUX_PLATFORM, home)).toEqual([]);
});

test("configured snippet directories recognize absent direct children but not sibling or nested files", () => {
  const home = testHome();
  const dir = join(home, "snippets");
  const mine = join(dir, "mine.sh");
  const target = record(home, {
    mutated: [{ path: mine }, { path: join(home, "snippets-other/mine.sh") }, { path: join(dir, "nested/mine.sh") }],
  });
  expect(unverifiedShellEdits(target, snippetPlatform(dir), home)).toEqual([mine]);
});

test("profile matching uses the record's conservative case behavior", () => {
  const home = testHome();
  const path = join(home, ".BASHRC");
  const target = record(home, { caseSensitive: false, mutated: [{ path }] });
  expect(unverifiedShellEdits(target, LINUX_PLATFORM, home)).toEqual([path]);
  expect(unverifiedShellEdits({ ...target, caseSensitive: true }, LINUX_PLATFORM, home)).toEqual([]);
});

test("unresolved shell paths are unique and stable across mutation/deletion evidence", () => {
  const home = testHome();
  const path = join(home, ".bashrc");
  expect(unverifiedShellEdits(record(home, { mutated: [{ path }], deleted: [{ path }] }), LINUX_PLATFORM, home)).toEqual([
    path,
  ]);
});
