import { loadRecords, removeRecord, saveRecord } from "../lib/records";
import { log } from "../lib/utilities";
import { removeAdded } from "../lib/removal";
import { removeRcLines } from "../lib/shellconfig";

export function uninstall(name: string | undefined, dryRun: boolean): void {
  if (!name || name.startsWith("--")) {
    console.log("Error");
    console.log("\tuninstall requires a tool name: tret uninstall <name> [--dry-run]");
    process.exit(1);
  }

  const record = loadRecords().records.find((existing) => existing.name === name);
  if (!record) {
    console.log("Error");
    console.log(`\tno tracked install named ${name}; see tret list`);
    process.exit(1);
  }

  // Edits are log-only: uninstall never restores a file the install changed.
  if (record.edited.length > 0) {
    console.log("Edited files left in place");
    for (const path of record.edited) {
      console.log(`\t${path}`);
    }
  }

  if (dryRun) {
    if (record.added.length === 0) {
      log(`nothing tracked to remove for ${name}`);
      return;
    }

    const plan = removeAdded(record.added, true);
    for (const path of plan.removed) {
      console.log(`\twould remove ${path}`);
    }
    for (const kept of plan.kept) {
      console.log(`\twould keep ${kept.path} (protected directory)`);
    }

    const rc = removeRcLines(name, record.added, true);
    for (const cleaned of rc.cleaned) {
      console.log(`\twould clean ${cleaned.file}: ${cleaned.line.trim()}`);
    }
    return;
  }

  if (record.added.length === 0) {
    removeRecord(name);
    log(`removed the ${name} record; it had no tracked files`);
    return;
  }

  log(`removing ${record.added.length} files and folders added by ${name}`);
  const result = removeAdded(record.added, false);

  for (const path of result.removed) {
    console.log(`\tremoved ${path}`);
  }
  for (const kept of result.kept) {
    console.log(`\tkept ${kept.path}${kept.reason === "guarded" ? " (protected directory)" : " (delete failed)"}`);
  }

  // A partial run keeps the record trimmed to what is left, so a retry only sees the survivors.
  if (result.kept.length > 0) {
    saveRecord({ ...record, added: result.kept.map((kept) => kept.path) });
    console.log("Error");
    console.log("\tsome paths were not removed and stay tracked; retry with sudo if they were permission-denied");
    process.exit(1);
  }

  const rc = removeRcLines(name, record.added, false);
  for (const cleaned of rc.cleaned) {
    console.log(`\tcleaned ${cleaned.file}: ${cleaned.line.trim()}`);
  }

  // The record stays so a retry can clean the lines it could not reach.
  if (rc.failed.length > 0) {
    for (const file of rc.failed) {
      console.log(`\tcould not clean ${file}`);
    }
    console.log("Error");
    console.log("\tsome shell config lines remain; run tret uninstall again to retry");
    process.exit(1);
  }

  removeRecord(name);
  log(`removed ${name}`);
}
