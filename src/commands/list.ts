import type { AbsolutePath, CaptureCompleteness, RecordV3 } from "../types";
import { FileStorage } from "../lib/store";
import { existsSync } from "node:fs";
import { log } from "../lib/utilities";

/** Whether a record's tracked executable is still on disk, so `list` never advertises a stale path. */
export type ListState = "installed" | "partial";

/** One printable `tret list` row, derived from a record plus an existence check so it is testable. */
export type ListRow = {
  name: string;
  source: string;
  url: string;
  installed: string;
  executable: string;
  state: ListState;
  script: string;
  completeness: CaptureCompleteness;
  owned: number;
  mutated: number;
  deleted: number;
};

/** Builds the sorted rows for a set of v3 records; `exists` is injectable so tests need no real files. */
export function listRows(records: RecordV3[], exists: (path: AbsolutePath) => boolean = existsSync): ListRow[] {
  return records
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((record) => {
      // A record whose executable is gone is stale (its paths were removed outside Tret); show `-`
      // for the binary and mark it `partial` rather than printing a path that no longer exists.
      const present = record.executable !== "" && exists(record.executable);
      return {
        name: record.name,
        source: record.source,
        url: record.url || "-",
        installed: record.installedAt.slice(0, 10),
        executable: present ? record.executable : "-",
        state: present ? "installed" : "partial",
        script: record.scriptSha256 ? record.scriptSha256.slice(0, 12) : "-",
        completeness: record.capture.completeness,
        owned: record.owned.length,
        mutated: record.mutated.length,
        deleted: record.deleted.length,
      };
    });
}

/** Renders the aligned table for a set of v3 records; the first line is the header. */
export function formatList(records: RecordV3[], exists: (path: AbsolutePath) => boolean = existsSync): string[] {
  const headers = [
    "Name",
    "Source",
    "URL",
    "Installed",
    "State",
    "Binary",
    "Script sha256",
    "Capture",
    "Owned",
    "Mutated",
    "Deleted",
  ];
  const columns = listRows(records, exists).map((row) => [
    row.name,
    row.source,
    row.url,
    row.installed,
    row.state,
    row.executable,
    row.script,
    row.completeness,
    String(row.owned),
    String(row.mutated),
    String(row.deleted),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...columns.map((column) => column[index]?.length ?? 0)),
  );
  // Text columns read left-aligned; the trailing counts stay right-aligned for easy comparison.
  const numeric = new Set([8, 9, 10]);
  const line = (cells: string[]): string =>
    cells.map((cell, index) => (numeric.has(index) ? cell.padStart(widths[index]!) : cell.padEnd(widths[index]!))).join("  ");

  return [line(headers), ...columns.map(line)];
}

/** Prints every recorded install with its capture completeness and owned/mutated/deleted counts. */
export async function list(): Promise<void> {
  const storage = new FileStorage();
  let records: RecordV3[];
  try {
    records = await storage.loadRecords();
  } catch (error) {
    log("Error");
    log(`\tcould not read the install records: ${message(error)}`);
    process.exit(1);
  }

  if (records.length === 0) {
    log("No installs tracked.");
    return;
  }

  for (const line of formatList(records)) {
    log(line);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
