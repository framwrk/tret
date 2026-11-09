import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const homes: string[] = [];
const script = join(import.meta.dir, "uninstall.sh");

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function confirmUninstall(home: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? ["script", "-q", "/dev/null", "bash", script]
      : ["script", "-q", "-e", "-c", `bash '${script.replaceAll("'", "'\\''")}'`, "/dev/null"];
  // macOS script expects a POSIX pipe; Bun's piped stdin is a socket.
  const proc = Bun.spawn(["bash", "-c", '"$@" < <(cat)', "--", ...command], {
    env: { ...process.env, HOME: home },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text();
  let output = "";
  let confirmed = false;
  try {
    for await (const chunk of proc.stdout) {
      output += Buffer.from(chunk).toString();
      if (!confirmed && output.includes("[y/N]")) {
        confirmed = true;
        proc.stdin.write("yes\n");
        await proc.stdin.flush();
      }
    }
    expect(await stderr).toBe("");
    expect(confirmed).toBe(true);
    expect(await proc.exited).toBe(0);
  } finally {
    proc.stdin.end();
    proc.kill();
  }
}

test.skipIf(Bun.which("script") === null).each(["owned", "foreign", "dangling"])(
  "uninstall script handles a %s symlink without removing foreign links",
  async (kind) => {
    const home = mkdtempSync(join(tmpdir(), "tret-self-uninstall-"));
    homes.push(home);
    const binary = join(home, ".tret", "bin", "tret");
    const link = join(home, ".local", "bin", "tret");
    mkdirSync(join(home, ".tret", "bin"), { recursive: true });
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(binary, "tret");
    const target = kind === "owned" ? binary : join(home, "other");
    if (kind === "foreign") writeFileSync(target, "other");
    symlinkSync(target, link);

    await confirmUninstall(home);

    expect(existsSync(binary)).toBe(false);
    if (kind === "owned") {
      expect(existsSync(link)).toBe(false);
      expect(() => lstatSync(link)).toThrow();
    } else {
      expect(readlinkSync(link)).toBe(target);
      if (kind === "foreign") expect(existsSync(target)).toBe(true);
    }
  },
);
