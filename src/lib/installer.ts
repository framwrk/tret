import { chmodSync, mkdtempSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { runLogOutput } from "./runlog";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { ttyOutput } from "./utilities";

const TEMP_PREFIX = "tret-install-";

/** Runs a downloaded install script: temp file, exec bit, spawn, then the exit code. */
export async function runInstaller(script: string, args: string[] = []): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const path = join(dir, "install.sh");

  try {
    await Bun.write(path, script);
    chmodSync(path, 0o755);

    // node:child_process, not Bun.spawn: when tret is piped (`tret install curl ... | bash`), the
    // script's output must not touch stdout — bash would execute every printed line. Stdout is always
    // a pipe, never a terminal: a script that checks `[ -t 1 ]` skips its interactive steps, such as
    // offering to start the tool it just installed with exec, which would never return to tret.
    // The output is copied to the same place tret prints: the terminal when stdout is one, else the
    // controlling terminal, else stderr.
    return await new Promise<number>((resolve) => {
      // Keep stderr attached to the terminal when it is one, so installers still see the same TTY.
      // In non-interactive runs, pipe it to retain the failure tail and forward synchronously.
      const child = spawn(path, args, { stdio: ["inherit", "pipe", process.stderr.isTTY ? "inherit" : "pipe"] });
      child.stdout?.on("data", (chunk: Buffer) => {
        writeOutput(chunk);
        runLogOutput(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        writeSync(2, chunk);
        runLogOutput(chunk);
      });
      child.once("close", (code) => resolve(code ?? 1));
      child.once("error", () => resolve(1));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Copies a chunk of script output to the terminal: stdout when it is one, else the controlling terminal, else stderr. */
function writeOutput(chunk: Buffer): void {
  if (process.stdout.isTTY) {
    process.stdout.write(chunk);
    return;
  }
  const fd = ttyOutput();
  if (fd === undefined) {
    process.stderr.write(chunk);
  } else {
    writeSync(fd, chunk);
  }
}
