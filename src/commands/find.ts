import type { AbsolutePath, OwnedEntry, RecordV3 } from "../types";
import { caseSensitiveFor, currentPlatform, processPrivilege } from "../lib/platform";
import { FileStorage } from "../lib/store";
import { detectManagedPackage } from "../lib/package-manager";
import { findRelated } from "../lib/related";
import { inspectPath } from "../lib/uninstall-planner";
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
  const owned = paths.map(ownedEntry);
  // Adoption can also recognize a package-manager global shim, so a found tool uninstalls through
  // the manager rather than by deleting shared global state.
  const managedBy = detectManagedPackage(executable, owned);
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
    caseSensitive: caseSensitiveFor(platform, executable),
    owned,
    mutated: [],
    deleted: [],
    ...(managedBy === undefined ? {} : { managedBy }),
  };

  await storage.saveRecord(record);
  log(`recorded ${name}`);
}

/** Fingerprints one adopted path with its kind, symlink target, and content hash (D4 evidence). */
function ownedEntry(path: AbsolutePath): OwnedEntry {
  const verification = inspectPath(path);
  const entry: OwnedEntry = { path, kind: verification.kind ?? "unknown" };
  if (verification.linkTarget !== undefined) entry.linkTarget = verification.linkTarget;
  if (verification.hash !== undefined) entry.installedHash = verification.hash;
  return entry;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
