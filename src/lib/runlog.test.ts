import { afterEach, describe, expect, test } from "bun:test";
import { closeRunLog, openRunLog, runLogLine, runLogOutput, runLogPhase } from "./runlog";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testHome: string | undefined;

afterEach(() => {
  closeRunLog(0);
  if (testHome) {
    rmSync(testHome, { recursive: true, force: true });
    testHome = undefined;
  }
});

function useTestHome(): string {
  testHome = mkdtempSync(join(tmpdir(), "tret-runlog-test-"));
  return testHome;
}

function logsDir(home: string): string {
  return join(home, ".tret", "logs");
}

function openedFile(home: string): string {
  return join(logsDir(home), readdirSync(logsDir(home))[0] ?? "");
}

describe("run log", () => {
  test("writes a header, phases, and output to one owner-only file", () => {
    const home = useTestHome();
    const path = openRunLog(["install", "https://example.com/install.sh"], home);
    runLogPhase("fetch-script");
    runLogLine("installed demo\n\towned 2 files");
    closeRunLog(0);

    expect(path).toBe(openedFile(home));
    expect(statSync(path!).mode & 0o777).toBe(0o600);
    const text = readFileSync(path!, "utf8");
    expect(text).toContain("run     version=");
    expect(text).toContain('command="install https://example.com/install.sh"');
    expect(text).toContain("phase   fetch-script");
    expect(text).toContain("out     installed demo");
    expect(text).toContain("out     \towned 2 files");
    expect(text).toContain("exit    code=0 last-phase=fetch-script");
  });

  test("masks secrets in the header and in output", () => {
    const home = useTestHome();
    const path = openRunLog(["install", "https://user:hunter2@example.com/i.sh?token=abc123", "--", "--api-key=zzz"], home);
    runLogLine("Authorization: Bearer topsecret");
    runLogLine("password: letmein");
    closeRunLog(0);

    const text = readFileSync(path!, "utf8");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("zzz");
    expect(text).not.toContain("topsecret");
    expect(text).not.toContain("letmein");
    expect(text).toContain("https://<redacted>@example.com");
    expect(text).toContain('--api-key=<redacted>"');
  });

  test("keeps the installer output tail only for a failed run, including a trailing partial line", () => {
    const home = useTestHome();
    const path = openRunLog(["install", "https://example.com/i.sh"], home);
    for (let i = 1; i <= 60; i++) runLogOutput(Buffer.from(`step ${i}\n`));
    runLogOutput(Buffer.from("half a li"));
    runLogOutput(Buffer.from("ne\r\n"));
    runLogOutput(Buffer.from("boom: partial"));
    const code = closeRunLog(1);

    expect(code).toBe(path);
    const text = readFileSync(path!, "utf8");
    expect(text).toContain("installer output (most recent lines):");
    expect(text).not.toContain("step 11\n");
    expect(text).toContain("step 12");
    expect(text).toContain("half a line");
    expect(text).toContain("boom: partial");
    expect(text).toContain("exit    code=1");
  });

  test("omits installer output on success and returns no path", () => {
    const home = useTestHome();
    const path = openRunLog(["install", "https://example.com/i.sh"], home);
    runLogOutput(Buffer.from("quiet success\n"));

    expect(closeRunLog(0)).toBeUndefined();
    expect(readFileSync(path!, "utf8")).not.toContain("installer output");
  });

  test("drops run logs older than 14 days even when their name sorts recent", () => {
    const home = useTestHome();
    const dir = logsDir(home);
    mkdirSync(dir, { recursive: true });
    const aged = join(dir, "2026-10-13T00-00-00-000Z-install-aged.log");
    const fresh = join(dir, "2026-10-12T00-00-00-000Z-install-fresh.log");
    writeFileSync(aged, "");
    writeFileSync(fresh, "");
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
    utimesSync(aged, old, old);

    openRunLog(["list"], home);
    closeRunLog(0);

    const names = readdirSync(dir);
    expect(names).not.toContain("2026-10-13T00-00-00-000Z-install-aged.log");
    expect(names).toContain("2026-10-12T00-00-00-000Z-install-fresh.log");
  });

  test("keeps only the newest 50 run logs", () => {
    const home = useTestHome();
    const dir = logsDir(home);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 52; i++) {
      writeFileSync(join(dir, `2026-01-01T00-00-${String(i).padStart(2, "0")}-000Z-install-x.log`), "");
    }

    openRunLog(["list"], home);
    closeRunLog(0);

    expect(readdirSync(dir)).toHaveLength(50);
  });

  test("does nothing and returns no path when the log directory cannot be created", () => {
    const home = useTestHome();
    const blocker = join(home, "not-a-dir");
    writeFileSync(blocker, "");

    expect(openRunLog(["list"], blocker)).toBeUndefined();
    expect(() => runLogPhase("apply")).not.toThrow();
    expect(() => runLogLine("still prints")).not.toThrow();
    expect(closeRunLog(1)).toBeUndefined();
  });
});
