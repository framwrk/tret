import { confirm, log } from "../lib/utilities";
import { loadRecords, removeRecord, saveRecord } from "../lib/records";
import { removeAdded } from "../lib/removal";
import { removeRcLines } from "../lib/shellconfig";

export function uninstall(name: string | undefined, dryRun: boolean, yes: boolean): void {
  if (!name || name.startsWith("--")) {
    log("Error");
    log("\tuninstall requires a tool name: tret uninstall <name> [--dry-run] [--yes]");
    process.exit(1);
  }

  const record = loadRecords().records.find((existing) => existing.name === name);
  if (!record) {
    log("Error");
    log(`\tno tracked install named ${name}; see tret list`);
    process.exit(1);
  }

  // Edits are log-only: uninstall never restores a file the install changed.
  if (record.edited.length > 0) {
    log("Edited files left in place");
    for (const path of record.edited) {
      log(`\t${path}`);
    }
  }

  if (dryRun) {
    if (record.added.length === 0) {
      log(`nothing tracked to remove for ${name}`);
      return;
    }

    const plan = removeAdded(record.added, name, true);
    for (const path of plan.removed) {
      log(`\twould remove ${path}`);
    }
    for (const path of plan.pruned) {
      log(`\twould prune ${path}`);
    }
    for (const kept of plan.kept) {
      log(`\twould keep ${kept.path} (protected directory)`);
    }

    const rc = removeRcLines(name, record.added, true);
    for (const cleaned of rc.cleaned) {
      log(`\twould clean ${cleaned.file}: ${cleaned.line.trim()}`);
    }
    return;
  }

  if (record.added.length === 0) {
    removeRecord(name);
    log(`removed the ${name} record; it had no tracked files`);
    return;
  }

  log(`uninstall ${name}?`);
  for (const path of record.added) {
    log(`\tremove ${path}`);
  }

  if (!yes) {
    const answer = confirm("proceed? [y/N]");
    if (answer === undefined) {
      log("Error");
      log("\tthere is no terminal to confirm on; pass --yes to uninstall without a prompt");
      process.exit(1);
    }
    if (!answer) {
      log(`aborted; ${name} is unchanged`);
      process.exit(0);
    }
  }

  log(`removing ${record.added.length} files and folders added by ${name}`, true);
  const result = removeAdded(record.added, name, false);

  for (const path of result.removed) {
    log(`\tremoved ${path}`, true);
  }
  for (const path of result.pruned) {
    log(`\tpruned ${path} (from a protected directory)`, true);
  }
  for (const kept of result.kept) {
    log(`\tkept ${kept.path}${kept.reason === "guarded" ? " (protected directory)" : " (delete failed)"}`);
  }

  // A partial run keeps the record trimmed to what is left, so a retry only sees the survivors.
  if (result.kept.length > 0) {
    saveRecord({ ...record, added: result.kept.map((kept) => kept.path) });
    log("Error");
    log("\tsome paths were not removed and stay tracked; retry with sudo if they were permission-denied");
    process.exit(1);
  }

  const rc = removeRcLines(name, record.added, false);
  for (const cleaned of rc.cleaned) {
    log(`\tcleaned ${cleaned.file}: ${cleaned.line.trim()}`);
  }

  // The record stays so a retry can clean the lines it could not reach.
  if (rc.failed.length > 0) {
    for (const file of rc.failed) {
      log(`\tcould not clean ${file}`);
    }
    log("Error");
    log("\tsome shell config lines remain; run tret uninstall again to retry");
    process.exit(1);
  }

  removeRecord(name);
  log(`removed ${name}`);
}
