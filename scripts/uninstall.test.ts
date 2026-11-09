import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const homes: string[] = [];
const script = join(import.meta.dir, "uninstall.sh");
const PTY_HARNESS = `
import errno
import os
import pty
import select
import signal
import sys
import time

pid, master = pty.fork()
if pid == 0:
    os.environ["HOME"] = sys.argv[2]
    os.execv("/bin/bash", ["bash", sys.argv[1]])

output = b""
sent = False
status = None
deadline = time.monotonic() + 15
while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], 0.1)
    if ready:
        try:
            chunk = os.read(master, 4096)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            chunk = b""
        output += chunk
        if not sent and b"[y/N]" in output:
            os.write(master, b"yes\\n")
            sent = True
    waited, result = os.waitpid(pid, os.WNOHANG)
    if waited:
        status = result
        break
else:
    os.kill(pid, signal.SIGTERM)
    os.waitpid(pid, 0)

os.write(1, output)
if status is None:
    sys.exit("uninstall script timed out")
if not sent:
    sys.exit("uninstall script never showed its confirmation prompt")
if not os.WIFEXITED(status):
    sys.exit(128 + os.WTERMSIG(status))
sys.exit(os.WEXITSTATUS(status))
`;

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function confirmUninstall(home: string): Promise<void> {
  const proc = Bun.spawn(["python3", "-c", PTY_HARNESS, script, home], {
    env: { ...process.env, HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(stderr).toBe("");
  expect(stdout).toContain("[y/N]");
  expect(code).toBe(0);
}

test.skipIf(Bun.which("python3") === null).each(["owned", "foreign", "dangling"])(
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
