import { loadRecords, saveRecord } from "../lib/records";
import { findRelated } from "../lib/related";
import { log } from "../lib/utilities";
import { resolveCommand } from "../lib/executable";

export function find(name: string | undefined): void {
  if (!name || name.startsWith("--") || name.includes("/")) {
    log("Error");
    log("\tfind requires a command name: tret find <name>");
    process.exit(1);
  }

  // A find record stands in for a real install, so the command has to exist first.
  const executable = resolveCommand(name);
  if (!executable) {
    log(`no command named ${name} on PATH`);
    return;
  }

  const existing = loadRecords().records.find((record) => record.name === name);
  if (existing) {
    log(`${name} is already tracked (from ${existing.installedAt.slice(0, 10)}); run tret uninstall ${name} first`);
    return;
  }

  const added = findRelated(name, executable);
  log(`found ${added.length} files and folders for ${name}`);
  for (const path of added) {
    log(`\t${path}`);
  }

  // No URL or script hash: the tool was not installed through Tret, so those fields stay empty.
  saveRecord({
    name,
    source: "find",
    url: "",
    installedAt: new Date().toISOString(),
    executable,
    scriptSha256: "",
    added,
    edited: [],
  });
  log(`recorded ${name}`);
}
