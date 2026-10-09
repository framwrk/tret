import type { CaptureCompleteness, RecordV3 } from "../types";
import { FileStorage } from "../lib/store";
import { log } from "../lib/utilities";

/** One printable `tret list` row, derived purely from a record so it can be tested without a terminal. */
export type ListRow = {
  name: string;
  source: string;
  url: string;
  installed: string;
  executable: string;
  script: string;
  completeness: CaptureCompleteness;
  owned: number;
  mutated: number;
  deleted: number;
};

/** Builds the sorted rows for a set of v3 records. */
export function listRows(records: RecordV3[]): ListRow[] {
  return records
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((record) => ({
      name: record.name,
      source: record.source,
      url: record.url || "-",
      installed: record.installedAt.slice(0, 10),
      executable: record.executable || "-",
      script: record.scriptSha256 ? record.scriptSha256.slice(0, 12) : "-",
      completeness: record.capture.completeness,
      owned: record.owned.length,
      mutated: record.mutated.length,
      deleted: record.deleted.length,
    }));
}

/** Renders the aligned table for a set of v3 records; the first line is the header. */
export function formatList(records: RecordV3[]): string[] {
  const headers = ["Name", "Source", "URL", "Installed", "Binary", "Script sha256", "Capture", "Owned", "Mutated", "Deleted"];
  const columns = listRows(records).map((row) => [
    row.name,
    row.source,
    row.url,
    row.installed,
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
  const line = (cells: string[]): string =>
    cells.map((cell, index) => (index < 7 ? cell.padEnd(widths[index]!) : cell.padStart(widths[index]!))).join("  ");

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
