import { loadRecords } from "../lib/records";
import { log } from "../lib/utilities";

/** Prints every recorded install as an aligned table: name, install URL, install date, and change counts. */
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
      url: record.url,
      installed: record.installedAt.slice(0, 10),
      executable: record.executable || "-",
      script: record.scriptSha256 ? record.scriptSha256.slice(0, 12) : "-",
      added: String(record.added.length),
      edited: String(record.edited.length),
    }));

  const nameWidth = Math.max("Name".length, ...rows.map((row) => row.name.length));
  const urlWidth = Math.max("URL".length, ...rows.map((row) => row.url.length));
  const installedWidth = Math.max("Installed".length, ...rows.map((row) => row.installed.length));
  const executableWidth = Math.max("Binary".length, ...rows.map((row) => row.executable.length));
  const scriptWidth = Math.max("Script sha256".length, ...rows.map((row) => row.script.length));
  const addedWidth = Math.max("Added".length, ...rows.map((row) => row.added.length));
  const editedWidth = Math.max("Edited".length, ...rows.map((row) => row.edited.length));

  log(
    `${"Name".padEnd(nameWidth)}  ${"URL".padEnd(urlWidth)}  ${"Installed".padEnd(installedWidth)}  ${"Binary".padEnd(executableWidth)}  ${"Script sha256".padEnd(scriptWidth)}  ${"Added".padEnd(addedWidth)}  ${"Edited".padEnd(editedWidth)}`,
  );

  for (const row of rows) {
    log(
      `${row.name.padEnd(nameWidth)}  ${row.url.padEnd(urlWidth)}  ${row.installed.padEnd(installedWidth)}  ${row.executable.padEnd(executableWidth)}  ${row.script.padEnd(scriptWidth)}  ${row.added.padStart(addedWidth)}  ${row.edited.padStart(editedWidth)}`,
    );
  }
}
