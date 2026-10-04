import { loadRecords } from "../lib/records";
import { log } from "../lib/utilities";

/** Prints every recorded install as an aligned table: name, install date, and change counts. */
export function list(): void {
  const records = loadRecords().records;

  if (records.length === 0) {
    log("No installs tracked.");
    return;
  }

  const rows = records
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((record) => ({
      name: record.name,
      installed: record.installedAt.slice(0, 10),
      added: String(record.added.length),
      edited: String(record.edited.length),
    }));

  const nameWidth = Math.max("Name".length, ...rows.map((row) => row.name.length));
  const installedWidth = Math.max("Installed".length, ...rows.map((row) => row.installed.length));
  const addedWidth = Math.max("Added".length, ...rows.map((row) => row.added.length));
  const editedWidth = Math.max("Edited".length, ...rows.map((row) => row.edited.length));

  log(
    `${"Name".padEnd(nameWidth)}  ${"Installed".padEnd(installedWidth)}  ${"Added".padEnd(addedWidth)}  ${"Edited".padEnd(editedWidth)}`,
  );

  for (const row of rows) {
    log(
      `${row.name.padEnd(nameWidth)}  ${row.installed.padEnd(installedWidth)}  ${row.added.padStart(addedWidth)}  ${row.edited.padStart(editedWidth)}`,
    );
  }
}
