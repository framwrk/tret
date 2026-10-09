import type { BoundedSessionResult, SessionCoverage } from "../lib/session";
import { currentPlatform, installObservationRoots } from "../lib/platform";
import { extractUrl, fetchScript, log, readLine, validateUrl } from "../lib/utilities";
import { findRecordByUrl, loadRecords, removeRecord, saveRecord } from "../lib/records";
import { formatCoverage, runBoundedSession } from "../lib/session";
import type { Platform } from "../lib/platform";
import type { Snapshot } from "../types";
import { captureBackendFor } from "../lib/capture/current";
import { diff } from "../lib/diff";
import { pickExecutable } from "../lib/executable";
import { removeAdded } from "../lib/removal";
import { removeRcLines } from "../lib/shellconfig";
import { runInstaller } from "../lib/installer";
import { snapshot } from "../lib/snapshot";

export async function install(url?: string, force = false, scriptArgs: string[] = [], capture = true): Promise<void> {
  if (!url) {
    log("Paste the install command (curl ... | bash):");
    url = await readLine();
  }

  // The paste is a shell command like `curl -fsSL https://... | bash`, not a bare URL.
  const pasted = extractUrl(url);
  if (!pasted) {
    log("Error");
    log(`\tno URL found in: ${url}`);
    process.exit(1);
  }
  url = pasted;

  const urlError = validateUrl(url);
  if (urlError) {
    log("Error");
    log(`\t${urlError}`);
    process.exit(1);
  }

  const existing = findRecordByUrl(url);
  if (existing && !force) {
    log("Error");
    log(
      `\t${existing.name} is already installed (from ${existing.installedAt.slice(0, 10)}); use tret install <URL> --force to reinstall`,
    );
    process.exit(1);
  }

  // A --force reinstall is an uninstall then install: the old tool and its record go first,
  // so the new record is recreated from a fresh diff and no stale added path survives it.
  if (existing && force) {
    log(`reinstalling ${existing.name}: removing the previous install first`);
    const removal = removeAdded(existing.added, existing.name, false);
    for (const path of removal.removed) {
      log(`\tremoved ${path}`);
    }
    for (const path of removal.pruned) {
      log(`\tpruned ${path} (from a protected directory)`);
    }
    for (const kept of removal.kept) {
      log(`\tkept ${kept.path} (${kept.reason})`);
    }

    // The record is trimmed so `tret uninstall <name>` can finish what this run could not.
    if (removal.kept.length > 0) {
      saveRecord({ ...existing, added: removal.kept.map((kept) => kept.path) });
      log("Error");
      log("\tprevious install could not be fully removed; run tret uninstall <name>, then tret install <URL> --force");
      process.exit(1);
    }

    const rc = removeRcLines(existing.name, existing.added, false);
    for (const cleaned of rc.cleaned) {
      log(`\tcleaned ${cleaned.file}: ${cleaned.line.trim()}`);
    }
    removeRecord(existing.name);
  }

  const script = await fetchScript(url);
  if (script === undefined) {
    log("Error");
    log(`\tURL does not return a raw script file: ${url}`);
    process.exit(1);
  }

  const scriptSha256 = new Bun.CryptoHasher("sha256").update(script).digest("hex");
  if (existing?.scriptSha256 && existing.scriptSha256 !== scriptSha256) {
    log(`the script at ${url} changed since ${existing.name} was last installed`);
  }

  const platform = currentPlatform();
  const before: Snapshot = snapshot();
  log(`snapshotted ${before.size} files and folders`, true);

  // The installer runs inside a bounded capture window. Tret does not run the installed tool to
  // discover lazy writes: lazy initialization is recorded only when the user runs the tool later,
  // which a future `tret trace` reserves a record segment for (D5).
  const window = await observeInstall(platform, script, scriptArgs, capture);
  log(
    window.coverage
      ? `observed the install with ${formatCoverage(window.coverage)}`
      : "capture disabled for this install; no observation window was recorded",
  );

  if (window.exitCode !== 0) {
    log("Error");
    log(`\tinstall script exited with code ${window.exitCode}: ${url}`);
    process.exit(1);
  }

  const after: Snapshot = snapshot();
  log(`snapshotted ${after.size} files and folders`, true);

  const changes = diff(before, after);

  // The tool name comes from the command the install actually put on disk, not the URL or a prompt.
  // Reinstalls add nothing (the binary is usually byte-identical), so fall back to edited paths,
  // and when the URL is already tracked, keep the name that install used rather than re-deriving it.
  const executable = pickExecutable(changes.added) ?? pickExecutable(changes.edited);
  const name = loadRecords().records.find((existing) => existing.url === url)?.name ?? executable?.split("/").pop();
  if (!executable || !name) {
    log("Error");
    log(`\tinstall script added no executable command: ${url}`);
    process.exit(1);
  }

  saveRecord({
    name,
    source: "install",
    url,
    installedAt: new Date().toISOString(),
    executable,
    scriptSha256,
    added: changes.added,
    edited: changes.edited,
  });

  log(`installed ${name}`);
  log(`\tadded ${changes.added.length} files and folders`);
  log(`\tedited ${changes.edited.length}`);
  log(`\tdeleted ${changes.deleted.length}`);
}

/**
 * Runs the installer once inside a bounded capture window when capture is enabled. Capture is
 * best-effort: a backend that cannot attach must not block the install, but the failure is never
 * silent — the caller reports that no window was observed. The installer runs exactly once either
 * way, and a failed capture close is reported as partial coverage by the session rather than
 * re-running the script.
 */
async function observeInstall(
  platform: Platform,
  script: string,
  scriptArgs: string[],
  capture: boolean,
): Promise<{ exitCode: number; coverage?: SessionCoverage }> {
  if (!capture) return { exitCode: await runInstaller(script, scriptArgs) };

  let session: BoundedSessionResult<number>;
  try {
    session = await runBoundedSession({
      backend: captureBackendFor(platform),
      // The installer is spawned as a child of this process, so observing this pid covers it.
      pid: process.pid,
      privilege: platform.privilege.defaultPrivilege,
      roots: installObservationRoots(platform),
      run: () => runInstaller(script, scriptArgs),
    });
  } catch (error) {
    log(`capture unavailable (${message(error)}); the install runs without an observation window`);
    return { exitCode: await runInstaller(script, scriptArgs) };
  }

  if (session.error !== undefined) throw session.error;
  return { exitCode: session.value ?? 1, coverage: session.coverage };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
