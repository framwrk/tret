import type { AbsolutePath, RecordFile, ToolRecord } from "../types";
import { RECORDS_PATH, RECORDS_VERSION } from "../constants";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Saves one install record, replacing any earlier record for the same tool name. */
export function saveRecord(record: ToolRecord): void {
  const stored = loadRecords();
  const records = stored.records.filter((existing) => existing.name !== record.name);
  records.push(record);
  writeAtomic(join(home(), RECORDS_PATH), { version: RECORDS_VERSION, records });
}

/** Drops the record for a tool name; an unknown name leaves the file untouched. */
export function removeRecord(name: string): void {
  const stored = loadRecords();
  const records = stored.records.filter((existing) => existing.name !== name);
  if (records.length === stored.records.length) {
    return;
  }

  writeAtomic(join(home(), RECORDS_PATH), { version: RECORDS_VERSION, records });
}

/** Finds the record for an install URL, or undefined when Tret never installed that URL. */
export function findRecordByUrl(url: string): ToolRecord | undefined {
  return loadRecords().records.find((record) => record.url === url);
}

/** Loads every saved install record; missing or unreadable files count as no records. */
export function loadRecords(): RecordFile {
  try {
    const file = JSON.parse(readFileSync(join(home(), RECORDS_PATH), "utf8")) as RecordFile;
    return { version: RECORDS_VERSION, records: file.records ?? [] };
  } catch {
    return { version: RECORDS_VERSION, records: [] };
  }
}

function home(): AbsolutePath {
  const dir = Bun.env.HOME;
  if (!dir) throw new Error("HOME is not set");
  return dir;
}

function writeAtomic(path: AbsolutePath, file: RecordFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, JSON.stringify(file, null, 2));
  renameSync(temp, path);
}
