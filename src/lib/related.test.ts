import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { findRelated } from "./related";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME_BACKUP = process.env.HOME;

afterEach(() => {
  process.env.HOME = HOME_BACKUP;
});

function testHome(): string {
  const home = mkdtempSync(join(tmpdir(), "tret-test-"));
  process.env.HOME = home;
  return home;
}

// The name is exotic on purpose: findRelated also scans the real /opt/homebrew/bin and /usr/local/bin.
const NAME = "tretfindtest";

describe("findRelated", () => {
  test("finds tool-named entries in the standard directories and keeps only the top-most path", () => {
    const home = testHome();
    mkdirSync(join(home, `.${NAME}/bin`), { recursive: true });
    writeFileSync(join(home, `.${NAME}/bin/${NAME}`), "");
    mkdirSync(join(home, `.config/${NAME}`), { recursive: true });
    mkdirSync(join(home, ".local/bin"), { recursive: true });
    writeFileSync(join(home, `.local/bin/${NAME}`), "");
    mkdirSync(join(home, "Library/Preferences"), { recursive: true });
    writeFileSync(join(home, `Library/Preferences/${NAME}.plist`), "");

    expect(findRelated(NAME, join(home, `.${NAME}/bin/${NAME}`))).toEqual([
      join(home, `.config/${NAME}`),
      join(home, `.local/bin/${NAME}`),
      join(home, `.${NAME}`),
      join(home, `Library/Preferences/${NAME}.plist`),
    ]);
  });

  test("ignores other tools' entries and keeps the executable even outside the standard directories", () => {
    const home = testHome();
    mkdirSync(join(home, `.config/${NAME}2`), { recursive: true });
    mkdirSync(join(home, `.config/${NAME}-beta`), { recursive: true });
    mkdirSync(join(home, "tools"), { recursive: true });
    writeFileSync(join(home, `tools/${NAME}`), "");

    expect(findRelated(NAME, join(home, `tools/${NAME}`))).toEqual([join(home, `tools/${NAME}`)]);
  });

  test("matches the name's rc file and suffixed dot files under home", () => {
    const home = testHome();
    writeFileSync(join(home, `.${NAME}rc`), "");
    writeFileSync(join(home, `.${NAME}.conf`), "");
    writeFileSync(join(home, `.${NAME}2`), "");

    expect(findRelated(NAME, join(home, `tools/${NAME}`))).toEqual([
      join(home, `.${NAME}.conf`),
      join(home, `.${NAME}rc`),
      join(home, `tools/${NAME}`),
    ]);
  });
});
