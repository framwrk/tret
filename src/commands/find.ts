import { caseSensitiveForPaths, currentPlatform, processPrivilege } from "../lib/platform";
import { detectManagedInstall, withoutManagedInstallPaths } from "../lib/managed-install";
import { emitJson, isJsonMode } from "../lib/json-output";
import { findRelated, relatedSearchRoots } from "../lib/related";
import { CaptureBudget } from "../lib/capture/budget";
import { EXIT_USAGE } from "../constants";
import { FileStorage } from "../lib/store";
import type { RecordV3 } from "../types";
import { adoptedEntries } from "../lib/adoption";
import { detectManagedPackage } from "../lib/package-manager";
import { fail } from "../lib/failure";
import { log } from "../lib/utilities";
import { randomUUID } from "node:crypto";
import { resolveCommand } from "../lib/executable";
import { runStoreOperation } from "../lib/command-operation";

/**
 * Adopts an already-installed command as a record. There is no install journal, so the record is
 * labeled `heuristic` and every candidate is fingerprinted from its current state. Cleanup still
 * needs explicit object approval; discovery and matching bytes never establish disposal authority.
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
  if (!storage.inOperation) return runStoreOperation(storage, () => find(name));
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

  const platform = currentPlatform();
  const budget = new CaptureBudget();
  const paths = findRelated(name, executable, platform, budget);
  const installedAt = new Date().toISOString();
  // Inventory descendants under the same budget; unavailable fingerprints remain unknown,
  // and every candidate still needs separate object approval before cleanup.
  const found = adoptedEntries(paths, budget);
  // Recognized manager/layout scopes remain unresolved; discovery cannot authorize their cleanup.
  const managedBy = detectManagedPackage(executable, found);
  const managedInstall = detectManagedInstall(executable, found);
  const owned = managedInstall === undefined ? found : withoutManagedInstallPaths(found, managedInstall);
  const caseSensitive = caseSensitiveForPaths(platform, [executable, ...paths]);
  budget.check();
  budget.pause();
  const resources = budget.report();
  for (const reason of resources.losses) log(`\tobservation loss: ${reason}`);
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
      segments: [{ kind: "find", backend: "find", startedAt: installedAt, endedAt: installedAt, resources, roots: [...new Set([executable, ...relatedSearchRoots(platform)])].sort(),
        partialReason: ["observed by tret find: no install journal exists", ...resources.losses].join("; ") }],
    },
    privilege: processPrivilege(),
    // Every adopted path is fingerprinted in this record, so the case flag is probed over all of
    // them plus the executable (D10); uninstall's overlap checks read this flag back.
    caseSensitive,
    owned,
    mutated: [],
    deleted: [],
    ...(managedBy === undefined ? {} : { managedBy }),
    ...(managedInstall === undefined ? {} : { managedInstall }),
  };

  await storage.saveRecord(record);
  if (isJsonMode()) {
    emitJson({ ok: true, command: "find", tool: name, id: record.id, candidates: owned, cleanupAuthority: "none", resources });
    return;
  }
  log(`recorded ${owned.length} candidate paths for ${name}`);
  for (const entry of owned) log(`\t${entry.path} (${entry.kind})`);
  log(`use tret approve ${record.id} <path> --remove to authorize an exact candidate`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
