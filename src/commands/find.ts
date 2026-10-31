import { EXIT_USAGE } from "../constants";
import { caseSensitiveForPaths, currentPlatform, processPrivilege } from "../lib/platform";
import { detectManagedInstall, withoutManagedInstallPaths } from "../lib/managed-install";
import { FileStorage } from "../lib/store";
import type { RecordV3 } from "../types";
import { adoptedEntries } from "../lib/adoption";
import { detectManagedPackage } from "../lib/package-manager";
import { fail } from "../lib/failure";
import { findRelated } from "../lib/related";
import { log } from "../lib/utilities";
import { randomUUID } from "node:crypto";
import { resolveCommand } from "../lib/executable";

/**
 * Adopts an already-installed command as a record. There is no install journal, so the record is
 * labeled `heuristic` and every path is fingerprinted from its current state; an owned file with a
 * matching hash uninstalls cleanly, and anything without one is reported rather than guessed at.
 */
export async function find(name: string | undefined): Promise<void> {
  if (!name || name.startsWith("--") || name.includes("/")) {
    fail("find-usage", "find requires a command name: tret find <name>", EXIT_USAGE);
  }

  // A find record stands in for a real install, so the command has to exist first.
  const executable = resolveCommand(name);
  if (!executable) {
    log(`no command named ${name} on PATH`);
    return;
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

  const existing = records.find((record) => record.name === name);
  if (existing) {
    log(`${name} is already tracked (from ${existing.installedAt.slice(0, 10)}); run tret uninstall ${name} first`);
    return;
  }

  const paths = findRelated(name, executable);
  log(`found ${paths.length} files and folders for ${name}`);
  for (const path of paths) {
    log(`\t${path}`);
  }

  const platform = currentPlatform();
  const installedAt = new Date().toISOString();
  // Folders bring their contents with them: every node inside an adopted directory is fingerprinted
  // so a later uninstall can empty it file by file instead of reporting an opaque `not-empty`.
  const found = adoptedEntries(paths);
  if (found.length > paths.length) log(`\tinventoried ${found.length} paths inside those folders`);
  // Adoption can also recognize a package-manager global shim, so a found tool uninstalls through
  // the manager rather than by deleting shared global state.
  const managedBy = detectManagedPackage(executable, found);
  // A first-party managed install is recognized the same way, so its unowned `node_modules` payload
  // is delegated rather than adopted into the record and stranded as a `not-empty` conflict.
  const managedInstall = detectManagedInstall(executable, found);
  const owned = managedInstall === undefined ? found : withoutManagedInstallPaths(found, managedInstall);
  // No URL or script hash: the tool was not installed through Tret, so those fields stay empty.
  const record: RecordV3 = {
    id: randomUUID(),
    name,
    source: "find",
    url: "",
    installedAt,
    executable,
    scriptSha256: "",
    capture: {
      backend: "find",
      completeness: "heuristic",
      segments: [{ kind: "find", startedAt: installedAt, partialReason: "adopted by tret find: no install journal exists" }],
    },
    privilege: processPrivilege(),
    // Every adopted path is fingerprinted in this record, so the case flag is probed over all of
    // them plus the executable (D10); uninstall's overlap checks read this flag back.
    caseSensitive: caseSensitiveForPaths(platform, [executable, ...paths]),
    owned,
    mutated: [],
    deleted: [],
    ...(managedBy === undefined ? {} : { managedBy }),
    ...(managedInstall === undefined ? {} : { managedInstall }),
  };

  await storage.saveRecord(record);
  log(`recorded ${name}`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
