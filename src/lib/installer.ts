import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { ttyOutput } from "./utilities";

const TEMP_PREFIX = "tret-install-";

/** Runs a downloaded install script: temp file, exec bit, spawn, then the exit code. */
export async function runInstaller(script: string): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const path = join(dir, "install.sh");

  try {
    await Bun.write(path, script);
    chmodSync(path, 0o755);

    // node:child_process, not Bun.spawn: when tret is piped (`tret install curl ... | bash`), the
    // script's output must not touch stdout — bash would execute every printed line. It goes to
    // the controlling terminal when there is one (an interactive paste still shows, unpainted);
    // a run with no terminal sends it to stderr, and a TTY run inherits stdout directly.
    return await new Promise<number>((resolve) => {
      const out = process.stdout.isTTY ? "inherit" : (ttyOutput() ?? process.stderr);
      const child = spawn(path, { stdio: ["inherit", out, "inherit"] });
      child.once("exit", (code) => resolve(code ?? 1));
      child.once("error", () => resolve(1));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
