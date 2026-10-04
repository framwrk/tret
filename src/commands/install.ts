import { diff, mergeDiff } from "../lib/diff";
import { fetchScript, log, validateUrl } from "../lib/utilities";
import { findRecordByUrl, loadRecords, removeRecord, saveRecord } from "../lib/records";
import type { Snapshot } from "../types";
import { pickExecutable } from "../lib/executable";
import { removeAdded } from "../lib/removal";
import { removeRcLines } from "../lib/shellconfig";
import { runFirstRun } from "../lib/first-run";
import { runInstaller } from "../lib/installer";
import { snapshot } from "../lib/snapshot";

export async function install(url?: string, force = false): Promise<void> {
  if (!url) {
    log("Error");
    log("\tinstall requires a URL: tret install <URL>");
    process.exit(1);
  }

  const urlError = validateUrl(url);
  if (urlError) {
    log("Error");
    log(`\t${urlError}`);
    process.exit(1);
  }

  const existing = findRecordByUrl(url);
  if (existing && !force) {
    log("Error");
    log(
      `\t${existing.name} is already installed (from ${existing.installedAt.slice(0, 10)}); use tret install <URL> --force to reinstall`,
    );
    process.exit(1);
  }

  // A --force reinstall is an uninstall then install: the old tool and its record go first,
  // so the new record is recreated from a fresh diff and no stale added path survives it.
  if (existing && force) {
    log(`reinstalling ${existing.name}: removing the previous install first`);
    const removal = removeAdded(existing.added, existing.name, false);
    for (const path of removal.removed) {
      log(`\tremoved ${path}`);
    }
    for (const path of removal.pruned) {
      log(`\tpruned ${path} (from a protected directory)`);
    }
    for (const kept of removal.kept) {
      log(`\tkept ${kept.path} (${kept.reason})`);
    }

    // The record is trimmed so `tret uninstall <name>` can finish what this run could not.
    if (removal.kept.length > 0) {
      saveRecord({ ...existing, added: removal.kept.map((kept) => kept.path) });
      log("Error");
      log("\tprevious install could not be fully removed; run tret uninstall <name>, then tret install <URL> --force");
      process.exit(1);
    }

    const rc = removeRcLines(existing.name, existing.added, false);
    for (const cleaned of rc.cleaned) {
      log(`\tcleaned ${cleaned.file}: ${cleaned.line.trim()}`);
    }
    removeRecord(existing.name);
  }

  const script = await fetchScript(url);
  if (script === undefined) {
    log("Error");
    log(`\tURL does not return a raw script file: ${url}`);
    process.exit(1);
  }

  const before: Snapshot = snapshot();
  log(`snapshotted ${before.size} files and folders`, true);

  const exitCode = await runInstaller(script);
  if (exitCode !== 0) {
    log("Error");
    log(`\tinstall script exited with code ${exitCode}: ${url}`);
    process.exit(1);
  }

  const after: Snapshot = snapshot();
  log(`snapshotted ${after.size} files and folders`, true);

  let changes = diff(before, after);

  // The tool name comes from the command the install actually put on disk, not the URL or a prompt.
  // Reinstalls add nothing (the binary is usually byte-identical), so fall back to edited paths,
  // and when the URL is already tracked, keep the name that install used rather than re-deriving it.
  const executable = pickExecutable(changes.added) ?? pickExecutable(changes.edited);
  const name = loadRecords().records.find((existing) => existing.url === url)?.name ?? executable?.split("/").pop();
  if (!executable || !name) {
    log("Error");
    log(`\tinstall script added no executable command: ${url}`);
    process.exit(1);
  }

  if (await runFirstRun(executable)) {
    const finalSnapshot: Snapshot = snapshot();
    log(`snapshotted ${finalSnapshot.size} files and folders`, true);
    changes = mergeDiff(changes, diff(before, finalSnapshot));
  }

  saveRecord({
    name,
    url,
    installedAt: new Date().toISOString(),
    added: changes.added,
    edited: changes.edited,
  });

  log(`installed ${name}`);
  log(`\tadded ${changes.added.length} files and folders`);
  log(`\tedited ${changes.edited.length}`);
  log(`\tdeleted ${changes.deleted.length}`);
}
