import { fetchScript, log } from "../lib/utilities";
import { UPDATE_SCRIPT_URL } from "../constants";
import { clearUpdateCheck } from "../lib/updatecheck";
import { runInstaller } from "../lib/installer";

// The update re-runs the published install script: it resolves the newest release itself,
// skips the download when the installed binary already matches its checksum, and otherwise
// replaces it atomically. No local version logic to drift out of sync with the releases.
export async function update(): Promise<void> {
  const script = await fetchScript(UPDATE_SCRIPT_URL);
  if (script === undefined) {
    log("Error");
    log(`\tcould not download the update script: ${UPDATE_SCRIPT_URL}`);
    process.exit(1);
  }

  const exitCode = await runInstaller(script);
  if (exitCode !== 0) {
    log("Error");
    log(`\tupdate script exited with code ${exitCode}`);
    process.exit(1);
  }

  // The new binary makes the cached check result wrong for the rest of its day.
  clearUpdateCheck();
}
