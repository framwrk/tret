import type { ManagedPackage, RecordV3 } from "../types";
import { describe, expect, test } from "bun:test";
import { findDelegatedRemovalConflicts, formatDelegatedRemovalConflict } from "./delegated-removal";
import { join } from "node:path";

const HOME = "/home/user";
const globalRoot = join(HOME, ".npm-global", "lib");
const npmPackage: ManagedPackage = { manager: "npm", package: "@acme/tool", globalRoot };
/** The directory `npm uninstall -g --prefix` would clear for `npmPackage`. */
const packageScope = join(globalRoot, "node_modules", "@acme", "tool");

function record(overrides: Partial<RecordV3> = {}): RecordV3 {
  return {
    id: "rec-1",
    name: "mytool",
    source: "install",
    url: "https://example.com/install.sh",
    installedAt: "2026-10-09T00:00:00.000Z",
    executable: join(HOME, ".local", "bin", "mytool"),
    scriptSha256: "a".repeat(64),
    capture: { backend: "macos-heuristic", completeness: "heuristic", segments: [] },
    privilege: "user",
    caseSensitive: true,
    owned: [],
    mutated: [],
    deleted: [],
    ...overrides,
  };
}

describe("findDelegatedRemovalConflicts", () => {
  test("flags another record's owned descendant inside a package-manager scope", () => {
    const claimed = join(packageScope, "dist", "cli.js");
    const removing = record({ id: "rec-acme", name: "acme", managedBy: npmPackage });
    const other = record({ id: "rec-other", name: "other", owned: [{ path: claimed, kind: "file" }] });

    expect(findDelegatedRemovalConflicts([packageScope], [removing, other], removing, HOME)).toEqual([
      { scope: packageScope, path: claimed, recordName: "other" },
    ]);
  });

  test("flags another record's executable claim inside the scope", () => {
    const shim = join(packageScope, "bin", "acme");
    const removing = record({ id: "rec-acme", name: "acme", managedBy: npmPackage });
    const other = record({ id: "rec-other", name: "other", executable: shim });

    expect(findDelegatedRemovalConflicts([packageScope], [removing, other], removing, HOME)).toEqual([
      { scope: packageScope, path: shim, recordName: "other" },
    ]);
  });

  test("flags another managed package whose scope contains this scope", () => {
    const removing = record({ id: "rec-tool", name: "tool", managedBy: npmPackage });
    const parentPackage: ManagedPackage = { manager: "npm", package: "@acme", globalRoot };
    const parentScope = join(globalRoot, "node_modules", "@acme");
    const other = record({ id: "rec-parent", name: "parent", managedBy: parentPackage });

    expect(findDelegatedRemovalConflicts([packageScope], [removing, other], removing, HOME)).toEqual([
      { scope: packageScope, path: parentScope, recordName: "parent" },
    ]);
  });

  test("treats another record's managed-install root as recursive, so an ancestor overlaps", () => {
    const root = join(HOME, ".pi", "agent", "install");
    const removing = record({
      id: "rec-pi",
      name: "pi",
      managedInstall: { kind: "pi", layout: "releases-v1", root },
    });
    const other = record({
      id: "rec-other",
      name: "other",
      managedInstall: { kind: "other", layout: "releases-v1", root: join(HOME, ".pi") },
    });

    expect(findDelegatedRemovalConflicts([root], [removing, other], removing, HOME)).toEqual([
      { scope: root, path: join(HOME, ".pi"), recordName: "other" },
    ]);
  });

  test("ignores a sibling package under the same global root", () => {
    const removing = record({ id: "rec-acme", name: "acme", managedBy: npmPackage });
    const sibling = join(globalRoot, "node_modules", "@acme", "other", "index.js");
    const other = record({ id: "rec-other", name: "other", owned: [{ path: sibling, kind: "file" }] });

    expect(findDelegatedRemovalConflicts([packageScope], [removing, other], removing, HOME)).toEqual([]);
  });

  test("ignores an unrelated record", () => {
    const removing = record({ id: "rec-acme", name: "acme", managedBy: npmPackage });
    const other = record({
      id: "rec-other",
      name: "other",
      owned: [{ path: join(HOME, ".config", "other"), kind: "file" }],
    });

    expect(findDelegatedRemovalConflicts([packageScope], [removing, other], removing, HOME)).toEqual([]);
  });

  test("skips claims made by the record being removed", () => {
    const removing = record({
      id: "rec-acme",
      name: "acme",
      managedBy: npmPackage,
      owned: [{ path: join(packageScope, "dist", "cli.js"), kind: "file" }],
    });

    expect(findDelegatedRemovalConflicts([packageScope], [removing], removing, HOME)).toEqual([]);
  });

  test("reports only the first conflicting record for each scope", () => {
    const removing = record({ id: "rec-acme", name: "acme", managedBy: npmPackage });
    const first = record({ id: "rec-a", name: "first", owned: [{ path: join(packageScope, "a"), kind: "file" }] });
    const second = record({ id: "rec-b", name: "second", owned: [{ path: join(packageScope, "b"), kind: "file" }] });

    expect(findDelegatedRemovalConflicts([packageScope], [removing, first, second], removing, HOME)).toEqual([
      { scope: packageScope, path: join(packageScope, "a"), recordName: "first" },
    ]);
  });

  test("does not treat a partial record's empty executable as a claim", () => {
    // `resolve("")` is the working directory, so a bare empty path would spuriously match this scope.
    const removing = record({ id: "rec-acme", name: "acme", managedBy: npmPackage });
    const partial = record({ id: "rec-partial", name: "partial", executable: "" });

    expect(findDelegatedRemovalConflicts([process.cwd()], [removing, partial], removing, HOME)).toEqual([]);
  });
});

describe("formatDelegatedRemovalConflict", () => {
  test("names the scope, the overlapping path, and the claiming record", () => {
    const path = join(packageScope, "cli.js");
    expect(formatDelegatedRemovalConflict({ scope: packageScope, path, recordName: "other" })).toBe(
      `conflict: delegated removal of ${packageScope} overlaps ${path}, claimed by other`,
    );
  });
});
