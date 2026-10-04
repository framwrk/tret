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

    // node:child_process, not Bun.spawn: when tret is piped (`tret install curl ... | bash`), the
    // script's output goes to tret's stderr — stdout would feed every printed line to bash. On a
    // TTY the script inherits stdout directly, so an interactive install is not painted red.
    return await new Promise<number>((resolve) => {
      const child = spawn(path, { stdio: ["inherit", process.stdout.isTTY ? "inherit" : process.stderr, "inherit"] });
      child.once("exit", (code) => resolve(code ?? 1));
      child.once("error", () => resolve(1));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
