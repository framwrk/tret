import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEMP_PREFIX = "tret-install-";

/** Runs a downloaded install script: temp file, exec bit, spawn, then the exit code. */
export async function runInstaller(script: string): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const path = join(dir, "install.sh");

  try {
    await Bun.write(path, script);
    chmodSync(path, 0o755);

    const proc = Bun.spawn([path], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    await proc.exited;
    return proc.exitCode ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
