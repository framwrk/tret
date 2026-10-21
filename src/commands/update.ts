// `tret update [tool]` (plan 03 items 3 and 5).
//
// Without an argument this updates Tret itself by re-running the published install script. With a
// tool name or record id it updates one tracked tool: the record's original URL and script arguments
// are re-used, the replacement script is fetched and validated before the working install is touched,
// and a failed update leaves the previous record in place so `uninstall` can still clean it up. Both
// paths emit one JSON document in JSON mode and keep stdout free of human text.

import { EXIT_AMBIGUOUS, EXIT_NOT_FOUND, EXIT_USAGE, UPDATE_SCRIPT_URL } from "../constants";
import { emitJson, isJsonMode } from "../lib/json-output";
import { fetchScript, log } from "../lib/utilities";
import { formatSelectionCandidates, selectRecord } from "../lib/record-selection";
import { FileStorage } from "../lib/store";
import type { RecordV3 } from "../types";
import { clearUpdateCheck } from "../lib/updatecheck";
import { fail } from "../lib/failure";
import { install } from "./install";
import { runInstaller } from "../lib/installer";

/**
 * The command entry. A bare `tret update` updates Tret itself; a selector updates one tracked tool
 * by re-running its recorded installer. The two workflows are kept apart so a typo in a tool name
 * never falls through to replacing the running binary.
 */
export async function update(tool?: string, yes = false): Promise<void> {
  if (tool === undefined) {
    await updateTret();
    return;
  }
  await updateTrackedTool(tool, yes);
}

/** Re-runs the published Tret install script and clears the cached update-check result. */
export async function updateTret(): Promise<void> {
  const script = await fetchScript(UPDATE_SCRIPT_URL);
  if (script === undefined) {
    fail("update-fetch", `could not download the update script: ${UPDATE_SCRIPT_URL}`);
  }

  const exitCode = await runInstaller(script);
  if (exitCode !== 0) {
    fail("update-script", `update script exited with code ${exitCode}`);
  }

  // The new binary makes the cached check result wrong for the rest of its day.
  clearUpdateCheck();
  if (isJsonMode()) {
    emitJson({ ok: true, command: "update", target: "tret", url: UPDATE_SCRIPT_URL });
  }
}

/**
 * Updates one tracked tool in place. The record is resolved first, then `install` re-runs the
 * recorded URL and arguments with the same stable id and display name. `install` fetches and
 * validates the replacement before it removes anything, so a download or validation failure leaves
 * the working install untouched; a failure during removal keeps a reduced record to retry.
 */
export async function updateTrackedTool(selector: string, yes: boolean): Promise<void> {
  let records: RecordV3[];
  try {
    records = await new FileStorage().loadRecords();
  } catch (error) {
    fail("update-records", `could not read the install records: ${message(error)}`);
  }

  const selection = selectRecord(records, selector);
  if (!selection.ok) {
    if (selection.reason === "ambiguous") {
      for (const candidate of formatSelectionCandidates(selection)) log(`\t${candidate}`);
      fail("update-ambiguous", selection.message, EXIT_AMBIGUOUS);
    }
    fail("update-not-found", selection.message, EXIT_NOT_FOUND);
  }

  const record = selection.record;
  if (record.url === "") {
    fail(
      "update-url",
      `${record.name} has no recorded installer URL; reinstall it with tret install <url>`,
      EXIT_USAGE,
    );
  }

  log(`updating ${record.name} from ${record.url}`);
  // `install` owns fetch, validation, preview, consent, removal, observation, and the partial-record
  // recovery path; this command only resolves which record to update and keeps its identity stable.
  await install(record.url, true, record.scriptArgs ?? [], {
    replaceId: record.id,
    name: record.name,
    commandName: "update",
    yes,
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
