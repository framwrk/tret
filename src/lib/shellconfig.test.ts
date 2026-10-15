import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { removeRcLines, shellConfigPaths } from "./shellconfig";
import { LINUX_PLATFORM } from "./platform";
import type { Platform } from "./platform";
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

  test("matches a PATH line written with $HOME or ~ instead of the expanded path", () => {
    const home = testHome();
    const file = join(home, ".zshrc");
    writeFileSync(file, `# mytool\nexport PATH="$HOME/.mytool/bin:$PATH"\nexport PATH=~/.mytool/bin:$PATH\n`);

    const rc = removeRcLines("mytool", [join(home, ".mytool")], false);

    expect(rc.cleaned).toHaveLength(3);
    expect(readFileSync(file, "utf8")).toBe("");
  });

  test("does not match a line that names a longer directory", () => {
    const home = testHome();
    const file = join(home, ".zshrc");
    const before = `export PATH=$HOME/.mytool-tools/bin:$PATH\nexport PATH=${home}/.mytool2/bin:$PATH\n`;

    writeFileSync(file, before);

    const rc = removeRcLines("mytool", [join(home, ".mytool")], false);

    expect(rc.cleaned).toHaveLength(0);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  test("only edits the attributed config files, leaving other matching configs intact", () => {
    const home = testHome();
    const zshrc = join(home, ".zshrc");
    const bash = join(home, ".bash_profile");
    const line = `export PATH=${home}/.mytool/bin:$PATH\n`;
    writeFileSync(zshrc, line);
    writeFileSync(bash, line);

    const rc = removeRcLines("mytool", [join(home, ".mytool")], false, [zshrc]);

    expect(rc.cleaned.map((cleaned) => cleaned.file)).toEqual([zshrc]);
    expect(readFileSync(zshrc, "utf8")).toBe("");
    expect(readFileSync(bash, "utf8")).toBe(line);
  });

  test("keeps a line the user edited to point elsewhere", () => {
    const home = testHome();
    const file = join(home, ".zshrc");
    const userLine = `export PATH=${home}/.mytool-custom/bin:$PATH\n`;
    writeFileSync(file, userLine);

    const rc = removeRcLines("mytool", [join(home, ".mytool")], false);

    expect(rc.cleaned).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(userLine);
  });

  test("cleans the fish config from the Linux table", () => {
    const home = testHome();
    mkdirSync(join(home, ".config/fish"), { recursive: true });
    const fish = join(home, ".config/fish/config.fish");
    writeFileSync(fish, `set -gx PATH ${home}/.mytool/bin $PATH\n`);

    const rc = removeRcLines("mytool", [join(home, ".mytool")], false, [fish], LINUX_PLATFORM);

    expect(rc.cleaned.map((cleaned) => cleaned.file)).toEqual([fish]);
    expect(rc.failed).toEqual([]);
    expect(readFileSync(fish, "utf8")).toBe("");
  });

  test("expands a directory entry to its snippet files and never edits the directory as a file", () => {
    const home = testHome();
    const snippets = mkdtempSync(join(tmpdir(), "tret-profile-"));
    const mine = join(snippets, "mytool.sh");
    const other = join(snippets, "other.sh");
    writeFileSync(mine, `export PATH=${home}/.mytool/bin:$PATH\n`);
    writeFileSync(other, "export PATH=/usr/local/bin:$PATH\n");
    const platform: Platform = {
      ...LINUX_PLATFORM,
      shellConfigs: [{ shell: "sh", scope: "absolute", path: snippets, kind: "directory" }],
    };

    expect(shellConfigPaths(platform)).toEqual([mine, other]);

    const rc = removeRcLines("mytool", [join(home, ".mytool")], false, undefined, platform);

    expect(rc.cleaned.map((cleaned) => cleaned.file)).toEqual([mine]);
    expect(rc.failed).toEqual([]);
    expect(readFileSync(mine, "utf8")).toBe("");
    expect(readFileSync(other, "utf8")).toBe("export PATH=/usr/local/bin:$PATH\n");
  });
});
