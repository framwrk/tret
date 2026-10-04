import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeRcLines } from "./shellconfig";
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

describe("shellconfig", () => {
  test("removes the PATH line and its tool comment", () => {
    const home = testHome();
    const file = join(home, ".zshrc");
    writeFileSync(file, `\n\n# mytool\nexport PATH=${home}/.mytool/bin:$PATH\n`);

    const rc = removeRcLines("mytool", [join(home, ".mytool")], false);

    expect(rc.cleaned).toHaveLength(2);
    expect(rc.failed).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("\n\n");
  });

  test("leaves other tools' lines and shared PATH entries alone", () => {
    const home = testHome();
    const file = join(home, ".zshrc");
    const before = "export PATH=$HOME/.local/bin:$PATH\n# other\ncd /Users/johnny/.mytool\n";

    writeFileSync(file, before);

    const rc = removeRcLines("mytool", ["/Users/johnny/.local/bin/mytool"], false);

    expect(rc.cleaned).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("dry run reports lines without writing", () => {
    const home = testHome();
    const file = join(home, ".zshrc");
    const before = `export PATH=${home}/.mytool/bin:$PATH\n`;

    writeFileSync(file, before);

    const rc = removeRcLines("mytool", [join(home, ".mytool")], true);

    expect(rc.cleaned).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("cleans every existing rc file", () => {
    const home = testHome();
    writeFileSync(join(home, ".zshrc"), `export PATH=${home}/.mytool/bin:$PATH\n`);
    writeFileSync(join(home, ".bash_profile"), `export PATH=${home}/.mytool/bin:$PATH\n`);

    const rc = removeRcLines("mytool", [join(home, ".mytool")], false);

    expect(rc.cleaned).toHaveLength(2);
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("");
    expect(readFileSync(join(home, ".bash_profile"), "utf8")).toBe("");
  });
});
