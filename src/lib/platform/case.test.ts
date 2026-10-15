import { describe, expect, test } from "bun:test";
import { detectCaseBehavior, flipAsciiCase } from "./case";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { PathIdentity } from "./case";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** An identity map standing in for disk, so every probe branch is deterministic. */
function statFrom(paths: Record<string, PathIdentity>): (candidate: string) => PathIdentity | undefined {
  return (candidate) => paths[candidate];
}

const identity = (dev: number, ino: number): PathIdentity => ({ dev, ino });

describe("flipAsciiCase", () => {
  test("flips ASCII letters and leaves digits, punctuation, and non-ASCII alone", () => {
    expect(flipAsciiCase("Case.TXT-01")).toBe("cASE.txt-01");
    expect(flipAsciiCase("123-_.é")).toBe("123-_.é");
  });
});

describe("detectCaseBehavior probe branches", () => {
  test("reports unknown when no ancestor name can be probed", () => {
    expect(detectCaseBehavior("/", statFrom({ "/": identity(1, 1) }))).toBe("unknown");
    expect(detectCaseBehavior("/123", statFrom({}))).toBe("unknown");
  });

  test("a missing case variant proves case-sensitive", () => {
    expect(detectCaseBehavior("/h/Data", statFrom({ "/h/Data": identity(1, 2) }))).toBe("sensitive");
  });

  test("the same file for both spellings proves case-insensitive", () => {
    const paths = { "/h/Data": identity(1, 2), "/h/dATA": identity(1, 2) };
    expect(detectCaseBehavior("/h/Data", statFrom(paths))).toBe("insensitive");
  });

  test("two different files for the two spellings prove case-sensitive", () => {
    const paths = { "/h/Data": identity(1, 2), "/h/dATA": identity(1, 3) };
    expect(detectCaseBehavior("/h/Data", statFrom(paths))).toBe("sensitive");
  });

  test("walks up past missing and letterless names to the deepest probeable ancestor", () => {
    const paths = {
      "/h/Data": identity(1, 2),
      "/h/dATA": identity(1, 2),
      "/h/123": identity(1, 5),
      "/h": identity(1, 6),
      "/H": identity(1, 6),
    };
    expect(detectCaseBehavior("/h/Data/123/New", statFrom(paths))).toBe("insensitive");
    // `/h/123` exists but has no ASCII letters to flip, so the probe falls back to `/h`.
    expect(detectCaseBehavior("/h/123", statFrom(paths))).toBe("insensitive");
  });
});

describe("detectCaseBehavior against the live filesystem", () => {
  test("agrees with the filesystem's own answer for existing and not-yet-created paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "tret-case-"));
    try {
      const mixed = join(dir, "CaseProbe");
      mkdirSync(mixed);
      // Ground truth: a differently cased spelling of the single entry resolves only when the
      // filesystem ignores case.
      const expected = existsSync(join(dir, "caseprobe")) ? "insensitive" : "sensitive";
      expect(detectCaseBehavior(mixed)).toBe(expected);
      expect(detectCaseBehavior(join(mixed, "not-created-yet"))).toBe(expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the filesystem root has no probeable name", () => {
    expect(detectCaseBehavior("/")).toBe("unknown");
  });
});
