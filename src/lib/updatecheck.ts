import type { AbsolutePath, UpdateCheckFile } from "../types";
import { INSTALLED_BINARY, UPDATE_CHECK_PATH } from "../constants";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { log } from "./utilities";
import { randomUUID } from "node:crypto";

const REPO = "framwrk/tret";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;
const BINARY = "tret-macos-arm64";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

/**
 * Prints a notice when the installed binary is older than the newest release.
 * The check itself (two fetches plus a hash of the binary) runs at most once a
 * day and is cached, so other runs pay nothing; a fresh cache decides the
 * notice on its own. Silent when up to date, and silent on any failure.
 */
export async function checkForUpdate(): Promise<void> {
  const cached = readCache();
  if (cached && Date.now() - Date.parse(cached.checkedAt) < CHECK_INTERVAL_MS) {
    if (cached.outdated) {
      printNotice(cached.tag);
    }
    return;
  }

  const tag = await latestTag();
  if (!tag) return;
  const expected = await releasedChecksum(tag);
  if (!expected) return;
  const installed = await sha256(join(home(), INSTALLED_BINARY));
  if (!installed) return;

  const outdated = installed !== expected;
  writeCache({ checkedAt: new Date().toISOString(), tag, outdated });
  if (outdated) {
    printNotice(tag);
  }
}

/** Drops the check cache, so the next run re-checks instead of trusting a result an update just made stale. */
export function clearUpdateCheck(): void {
  try {
    rmSync(join(home(), UPDATE_CHECK_PATH), { force: true });
  } catch {
    // Cache cleanup must not turn a successful update into a failed command.
  }
}

async function latestTag(): Promise<string | undefined> {
  try {
    const response = await fetch(RELEASES_API, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const releases = (await response.json()) as Array<{ tag_name?: string }>;
    const tag = releases[0]?.tag_name;
    return tag && tag.startsWith("v") ? tag : undefined;
  } catch {
    return undefined;
  }
}

async function releasedChecksum(tag: string): Promise<string | undefined> {
  try {
    const url = `https://github.com/${REPO}/releases/download/${tag}/checksums.txt`;
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const text = await response.text();
    const line = text.split("\n").find((entry) => entry.endsWith(` ${BINARY}`));
    return line?.split(" ")[0];
  } catch {
    return undefined;
  }
}

async function sha256(path: AbsolutePath): Promise<string | undefined> {
  try {
    const hasher = new Bun.CryptoHasher("sha256");
    for await (const chunk of Bun.file(path).stream()) {
      hasher.update(chunk);
    }
    return hasher.digest("hex");
  } catch {
    return undefined;
  }
}

function readCache(): UpdateCheckFile | undefined {
  try {
    const file = JSON.parse(readFileSync(join(home(), UPDATE_CHECK_PATH), "utf8")) as Partial<UpdateCheckFile>;
    if (typeof file.checkedAt === "string" && typeof file.tag === "string" && typeof file.outdated === "boolean") {
      return file as UpdateCheckFile;
    }
  } catch {
    // A missing or unreadable cache counts as no check yet.
  }
  return undefined;
}

function writeCache(check: UpdateCheckFile): void {
  let temp: string | undefined;
  try {
    const path = join(home(), UPDATE_CHECK_PATH);
    mkdirSync(dirname(path), { recursive: true });
    temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(check, null, 2), { flag: "wx" });
    renameSync(temp, path);
  } catch {
    // The optional update cache must not make another Tret command fail.
  } finally {
    if (temp) {
      try {
        rmSync(temp, { force: true });
      } catch {
        // A leftover temporary cache file is harmless; cache cleanup is best effort.
      }
    }
  }
}

function printNotice(tag: string): void {
  log(`Tret ${tag} is available - run tret update to install it`);
}

function home(): AbsolutePath {
  const dir = Bun.env.HOME;
  if (!dir) throw new Error("HOME is not set");
  return dir;
}
