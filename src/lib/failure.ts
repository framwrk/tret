// One failure path for commands (plan 03 item 5).
//
// Commands used to repeat `log("Error"); log("\t..."); process.exit(1)`. Centralizing it keeps the
// human output identical while making the JSON error document and the exit code consistent, so
// automation gets a stable contract and humans keep the message they expect.

import { EXIT_ERROR } from "../constants";
import { emitJsonError } from "./json-output";
import { log } from "./utilities";

/** Prints a failed command's message in the usual human shape, emits JSON in JSON mode, and exits. */
export function fail(code: string, message: string, exitCode: number = EXIT_ERROR): never {
  log("Error");
  log(`\t${message}`);
  emitJsonError(code, message);
  process.exit(exitCode);
}
