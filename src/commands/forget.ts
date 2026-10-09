import { FileStorage } from "../lib/store";
import type { RecordV3 } from "../types";
import { log } from "../lib/utilities";

/**
 * Drops a tracked record without touching any files. This is the explicit escape hatch for a record
 * whose remaining entries are not worth acting on — for example detect-only mutations of unrelated
 * churn that can never be restored. `uninstall` removes files; `forget` only stops tracking them.
 */
export async function forget(name: string | undefined): Promise<void> {
  if (!name || name.startsWith("--")) {
    log("Error");
    log("\tforget requires a tool name: tret forget <name>");
    process.exit(1);
  }

  const storage = new FileStorage();
  let records: RecordV3[];
  try {
    records = await storage.loadRecords();
  } catch (error) {
    log("Error");
    log(`\tcould not read the install records: ${message(error)}`);
    process.exit(1);
  }

  const record = records.find((existing) => existing.name === name);
  if (!record) {
    log("Error");
    log(`\tno tracked install named ${name}; see tret list`);
    process.exit(1);
  }

  await storage.removeRecord(record.id);
  log(`forgot ${name}; its files were left untouched`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
