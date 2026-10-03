import { isScript, log, validateUrl } from "../lib/utilities";
import type { Snapshot } from "../types";
import { snapshot } from "../lib/snapshot";

export async function install(url?: string): Promise<void> {
  if (!url) {
    console.log("Error");
    console.log("\tinstall requires a URL: tidy install <URL>");
    process.exit(1);
  }

  const urlError = validateUrl(url);
  if (urlError) {
    console.log("Error");
    console.log(`\t${urlError}`);
    process.exit(1);
  }

  if (!(await isScript(url))) {
    console.log("Error");
    console.log(`\tURL does not return a raw script file: ${url}`);
    process.exit(1);
  }

  log("install command called");

  const before: Snapshot = snapshot();
  log(`snapshotted ${before.size} files and folders`);

  // install tool

  const after: Snapshot = snapshot();
  log(`snapshotted ${after.size} files and folders`);

  // save tool details

  // save differences
}
