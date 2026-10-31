// `tret unclaim <tool> <path>` (D4).
//
// Shared ownership is never resolved by guessing: two records may claim one path, and uninstall
// keeps it until the user says which record should stop claiming it. This command is that explicit
// step. It changes no file on disk and never moves a claim; it only drops the selected record's
// claim so the remaining record is the sole owner and a normal, non-forced uninstall becomes
// possible. It refuses when the path is not claimed, or when the selected record is the only
// claimant, because that would stop tracking a path rather than resolve a conflict.

import { EXIT_AMBIGUOUS, EXIT_BLOCKED, EXIT_NOT_FOUND, EXIT_USAGE } from "../constants";
import { FileStorage, collectUnreferencedBlobs } from "../lib/store";
import { emitJson, isJsonMode } from "../lib/json-output";
import { formatSelectionCandidates, selectRecord } from "../lib/record-selection";
import type { RecordV3 } from "../types";
import { fail } from "../lib/failure";
import { log } from "../lib/utilities";
import { resolve } from "node:path";
import { unclaimSharedPath } from "../lib/uninstall-planner";

/** Drops one record's claim on a shared path without touching disk or the other record. */
export async function unclaim(selector: string | undefined, rawPath: string | undefined): Promise<void> {
  if (!selector || selector.startsWith("--") || !rawPath || rawPath.startsWith("--")) {
    fail("unclaim-usage", "unclaim requires a tool name or record id and a path: tret unclaim <tool> <path>", EXIT_USAGE);
  }

  const storage = new FileStorage();
  let records: RecordV3[];
  try {
    records = await storage.loadRecords();
  } catch (error) {
    fail("unclaim-records", `could not read the install records: ${message(error)}`);
  }

  const selection = selectRecord(records, selector);
  if (!selection.ok) {
    if (selection.reason === "ambiguous") {
      for (const candidate of formatSelectionCandidates(selection)) log(`\t${candidate}`);
      fail("unclaim-ambiguous", selection.message, EXIT_AMBIGUOUS);
    }
    fail("unclaim-not-found", selection.message, EXIT_NOT_FOUND);
  }

  const record = selection.record;
  const path = resolve(rawPath);
  const result = unclaimSharedPath(record, path, records);

  if (!result.ok) {
    if (result.reason === "not-claimed") {
      fail("unclaim-not-claimed", `${record.name} does not claim ${path}; nothing was changed`, EXIT_NOT_FOUND);
    }
    fail(
      "unclaim-not-shared",
      `${record.name} is the only record claiming ${path}; nothing was changed (use tret forget to stop tracking the tool)`,
      EXIT_BLOCKED,
    );
  }

  await storage.saveRecord(result.record);
  // Dropping a claim can leave a record without its last reference to a before-image; sweep after
  // the save, best-effort, so this successful unclaim is never reported as failed for cleanup.
  await collectUnreferencedBlobs();

  if (isJsonMode()) {
    emitJson({
      ok: true,
      command: "unclaim",
      tool: record.name,
      id: record.id,
      path,
      removed: result.removed,
      remaining: result.remaining,
    });
    return;
  }

  log(`unclaimed ${path} from ${record.name}`);
  for (const section of result.removed) log(`\tremoved the ${section} claim`);
  for (const owner of result.remaining) log(`\tstill claimed by ${owner.name} (${owner.id})`);
  log("\tnothing on disk was changed; uninstall can now plan against the remaining owner");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
