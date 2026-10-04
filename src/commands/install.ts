import { diff, mergeDiff } from "../lib/diff";
import { fetchScript, log, validateUrl } from "../lib/utilities";
import { loadRecords, saveRecord } from "../lib/records";
import type { Snapshot } from "../types";
import { pickExecutable } from "../lib/executable";
import { runFirstRun } from "../lib/first-run";
import { runInstaller } from "../lib/installer";
import { snapshot } from "../lib/snapshot";

export async function install(url?: string): Promise<void> {
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

  const script = await fetchScript(url);
  if (script === undefined) {
    log("Error");
    log(`\tURL does not return a raw script file: ${url}`);
    process.exit(1);
  }

  const before: Snapshot = snapshot();
  log(`snapshotted ${before.size} files and folders`);

  const exitCode = await runInstaller(script);
  if (exitCode !== 0) {
    log("Error");
    log(`\tinstall script exited with code ${exitCode}: ${url}`);
    process.exit(1);
  }

  const after: Snapshot = snapshot();
  log(`snapshotted ${after.size} files and folders`);

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
    log(`snapshotted ${finalSnapshot.size} files and folders`);
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
