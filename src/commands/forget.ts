// `tret forget <tool>` (plan 03 items 4 and 5).
//
// Drops a tracked record without touching any files. This is the explicit escape hatch for a record
// whose remaining entries are not worth acting on — for example detect-only mutations of unrelated
// churn that can never be restored. `uninstall` removes files; `forget` only stops tracking them.
// The selector resolves through the same `selectRecord` every other command uses, so a display name
// shared by several records fails and lists the ids instead of silently dropping the first one.

import { EXIT_AMBIGUOUS, EXIT_NOT_FOUND, EXIT_USAGE } from "../constants";
import { emitJson, isJsonMode } from "../lib/json-output";
import { formatSelectionCandidates, selectRecord } from "../lib/record-selection";
import { FileStorage } from "../lib/store";
import type { RecordV3 } from "../types";
import { fail } from "../lib/failure";
import { log } from "../lib/utilities";

/** Drops one record; `selector` is a display name or a stable record id. */
export async function forget(selector: string | undefined): Promise<void> {
  if (!selector || selector.startsWith("--")) {
    fail("forget-usage", "forget requires a tool name or record id: tret forget <tool>", EXIT_USAGE);
  }

  let records: RecordV3[];
  try {
    records = await new FileStorage().loadRecords();
  } catch (error) {
    fail("forget-records", `could not read the install records: ${message(error)}`);
  }

  const selection = selectRecord(records, selector);
  if (!selection.ok) {
    if (selection.reason === "ambiguous") {
      for (const candidate of formatSelectionCandidates(selection)) log(`\t${candidate}`);
      fail("forget-ambiguous", selection.message, EXIT_AMBIGUOUS);
    }
    fail("forget-not-found", selection.message, EXIT_NOT_FOUND);
  }

  const record = selection.record;
  await new FileStorage().removeRecord(record.id);

  if (isJsonMode()) {
    emitJson({ ok: true, command: "forget", tool: record.name, id: record.id });
    return;
  }

  log(`forgot ${record.name}; its files were left untouched`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
