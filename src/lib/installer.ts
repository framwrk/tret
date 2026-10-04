import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const TEMP_PREFIX = "tret-install-";

/** Runs a downloaded install script: temp file, exec bit, spawn, then the exit code. */
export async function runInstaller(script: string): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const path = join(dir, "install.sh");

  try {
    await Bun.write(path, script);
    chmodSync(path, 0o755);

    // node:child_process, not Bun.spawn: the script's output goes to tret's stderr, not stdout —
    // a pasted `tret install curl ... | bash` would otherwise feed the script's output to bash.
    return await new Promise<number>((resolve) => {
      const child = spawn(path, { stdio: ["inherit", process.stderr, "inherit"] });
      child.once("exit", (code) => resolve(code ?? 1));
      child.once("error", () => resolve(1));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
