import type { AbsolutePath } from "../types";
import { spawn } from "node:child_process";

const HELP_TIMEOUT_MS = 5_000;

/** Runs the freshly installed tool once with --help so runtime files land in the record; true when something ran. */
export async function runFirstRun(executable: AbsolutePath): Promise<boolean> {
  // node:child_process, not Bun.spawn: only a detached process group can be killed whole, and Bun.spawn
  // has no group kill — its timeout SIGTERMs just the direct child, orphaning anything it spawned.
  await new Promise<void>((resolve) => {
    const child = spawn(executable, ["--help"], { stdio: "ignore", detached: true });
    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // already gone
        }
      }
    }, HELP_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return true;
}
