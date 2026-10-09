import type { AbsolutePath, CaptureCompleteness, CaptureInfo, CaptureSegment, Diff, RecordV3 } from "../types";
import type { BoundedSessionResult, SessionCoverage } from "../lib/session";
import { DEFAULT_BACKUP_POLICY, FileStorage } from "../lib/store";
import { applyUninstallPlan, describeOutcome, reduceRecordForRetry } from "../lib/removal";
import { caseSensitiveFor, currentPlatform, installObservationRoots, processPrivilege } from "../lib/platform";
import { extractUrl, fetchScript, log, readLine, validateUrl } from "../lib/utilities";
import { formatCoverage, runBoundedSession } from "../lib/session";
import type { CaptureBackend } from "../lib/capture/backend";
import type { Journal } from "../lib/capture/events";
import type { NormalizedEffects } from "../lib/capture/normalize";
import type { Platform } from "../lib/platform";
import { VerifiedUninstallPlanner } from "../lib/uninstall-planner";
import { captureBackendFor } from "../lib/capture/current";
import { diff } from "../lib/diff";
import { normalizeJournal } from "../lib/journal/normalize";
import { pickExecutable } from "../lib/executable";
import { randomUUID } from "node:crypto";
import { removeRcLines } from "../lib/shellconfig";
import { runInstaller } from "../lib/installer";
import { snapshot } from "../lib/snapshot";

/** Options for `install`; the command line uses the defaults, tests inject capture seams. */
export type InstallOptions = {
  /** Attach a bounded capture window; the `--no-capture` flag turns this off. */
  capture?: boolean;
  /** Capture backend override; defaults to the running platform's backend (D1/D7). */
  backend?: CaptureBackend;
  /** Observation roots override (D3); defaults to the platform's bounded install roots. */
  roots?: AbsolutePath[];
  /** Clock; injectable so a test can pin `installedAt` and the window timestamps. */
  now?: () => number;
};

export async function install(
  url?: string,
  force = false,
  scriptArgs: string[] = [],
  options: InstallOptions = {},
): Promise<void> {
  const clock = options.now ?? Date.now;

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

  const storage = new FileStorage();
  let records: RecordV3[];
  try {
    records = await storage.loadRecords();
  } catch (error) {
    log("Error");
    log(`\tcould not read the install records: ${message(error)}`);
    process.exit(1);
  }

  const existing = records.find((record) => record.url === url);
  if (existing && !force) {
    log("Error");
    log(
      `\t${existing.name} is already installed (from ${existing.installedAt.slice(0, 10)}); use tret install <URL> --force to reinstall`,
    );
    process.exit(1);
  }

  // A --force reinstall is an uninstall then install: the old tool and its record go first through
  // the same verified planner an explicit uninstall uses, so no stale owned path survives it.
  if (existing && force) {
    await removePrevious(storage, existing, records);
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
  const caseSensitive = caseSensitiveFor(platform, Bun.env.HOME);

  // The installer runs inside a bounded capture window. With capture on, the journal is the sole
  // effects source, so no global snapshot runs. `--no-capture` (or a backend that cannot attach)
  // falls back to the legacy snapshot/diff, whose hash-less entries uninstall treats as unverified.
  const window = await observeInstall(platform, script, scriptArgs, options);
  log(
    window.coverage
      ? `observed the install with ${formatCoverage(window.coverage)}`
      : "capture disabled for this install; no observation window was recorded",
  );

  const effects = buildEffects(window, caseSensitive);

  // The tool name comes from the executable the install actually put on disk, not the URL or a
  // prompt; when the URL is already tracked, keep the name that install used rather than re-deriving.
  const executable = pickExecutable(effects.owned.map((entry) => entry.path));
  const name = existing?.name ?? executable?.split("/").pop();
  if (!executable || !name) {
    log("Error");
    log(`\tinstall script added no executable command: ${url}`);
    process.exit(1);
  }

  const failed = window.exitCode !== 0;
  const record: RecordV3 = {
    id: randomUUID(),
    name,
    source: "install",
    url,
    installedAt: new Date(clock()).toISOString(),
    executable,
    scriptSha256,
    capture: buildCapture(window, failed, clock),
    privilege: processPrivilege(),
    caseSensitive,
    owned: effects.owned,
    mutated: effects.mutated,
    deleted: effects.deleted,
  };
  await storage.saveRecord(record);

  if (failed) {
    // D6: a wrong exit keeps a labeled partial record instead of silently undoing the changes.
    log("Error");
    log(`\tinstall script exited with code ${window.exitCode}: ${url}`);
    log(`\tkept a partial record for ${name}; inspect it with tret list, remove it with tret uninstall ${name}`);
    process.exit(1);
  }

  log(`installed ${name}`);
  log(`\towned ${effects.owned.length} files and folders`);
  log(`\tmutated ${effects.mutated.length}`);
  log(`\tdeleted ${effects.deleted.length}`);
}

/** What one install window produced: the exit code, its capture, and a fallback diff when no journal exists. */
type InstallWindow = {
  exitCode: number;
  coverage?: SessionCoverage;
  journal?: Journal;
  /** Legacy snapshot/diff, only present when no capture window produced a journal. */
  fallback?: Diff;
};

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
  options: InstallOptions,
): Promise<InstallWindow> {
  if (!(options.capture ?? true)) {
    const before = snapshot();
    const exitCode = await runInstaller(script, scriptArgs);
    return { exitCode, fallback: diff(before, snapshot()) };
  }

  let session: BoundedSessionResult<number>;
  try {
    session = await runBoundedSession({
      backend: options.backend ?? captureBackendFor(platform),
      // The installer is spawned as a child of this process, so observing this pid covers it.
      pid: process.pid,
      privilege: processPrivilege(),
      roots: options.roots ?? installObservationRoots(platform),
      run: () => runInstaller(script, scriptArgs),
    });
  } catch (error) {
    log(`capture unavailable (${message(error)}); the install runs without an observation window`);
    const before = snapshot();
    const exitCode = await runInstaller(script, scriptArgs);
    return { exitCode, fallback: diff(before, snapshot()) };
  }

  if (session.error !== undefined) throw session.error;
  return { exitCode: session.value ?? 1, coverage: session.coverage, journal: session.journal };
}

/** Normalizes the captured journal into effects; a fallback diff maps to hash-less legacy entries. */
function buildEffects(window: InstallWindow, caseSensitive: boolean): NormalizedEffects {
  if (window.journal) {
    return normalizeJournal({ journal: window.journal, backups: DEFAULT_BACKUP_POLICY, caseSensitive });
  }

  const changes = window.fallback ?? { added: [], edited: [], deleted: [] };
  return {
    owned: changes.added.map((path) => ({ path, kind: "unknown" as const })),
    mutated: changes.edited.map((path) => ({ path })),
    deleted: changes.deleted.map((path) => ({ path })),
    diagnostics: [],
  };
}

/** Builds the record's capture info; a non-zero installer exit is labeled partial (D6). */
function buildCapture(window: InstallWindow, failed: boolean, clock: () => number): CaptureInfo {
  const at = new Date(clock()).toISOString();
  const segment: CaptureSegment = window.coverage
    ? { ...window.coverage.segment }
    : { kind: "install", startedAt: at, endedAt: at, partialReason: "capture disabled for this install" };
  let completeness: CaptureCompleteness = window.coverage?.completeness ?? "heuristic";

  if (failed) {
    completeness = "partial";
    segment.partialReason = combineReasons(segment.partialReason, `installer exited with code ${window.exitCode}`);
  }

  return {
    backend: window.coverage?.backend ?? "none",
    completeness,
    segments: [segment],
  };
}

/**
 * Removes the previously recorded install through the verified planner before a --force reinstall.
 * A run the planner cannot finish keeps a reduced record so `tret uninstall <name>` can retry, and
 * stops the reinstall rather than stacking a second record on top of live paths.
 */
async function removePrevious(storage: FileStorage, existing: RecordV3, records: RecordV3[]): Promise<void> {
  log(`reinstalling ${existing.name}: removing the previous install first`);
  const planner = new VerifiedUninstallPlanner();
  const plan = await planner.plan(existing, { otherRecords: records, force: true });
  const result = await applyUninstallPlan(plan, { storage });

  const announced = new Set(
    plan.actions.filter((action) => action.action === "conflict" || action.action === "skip").map((action) => action.path),
  );
  for (const outcome of result.outcomes) {
    if ((outcome.outcome === "conflict" || outcome.outcome === "skipped") && announced.has(outcome.path)) continue;
    log(`\t${describeOutcome(outcome)}`);
  }

  const rc = removeRcLines(
    existing.name,
    existing.owned.map((entry) => entry.path),
    false,
  );
  for (const cleaned of rc.cleaned) {
    log(`\tcleaned ${cleaned.file}: ${cleaned.line.trim()}`);
  }

  if (result.incomplete) {
    const reduced = reduceRecordForRetry(
      existing,
      result,
      rc.cleaned.map((cleaned) => cleaned.file),
    );
    const remaining = reduced.owned.length + reduced.mutated.length + reduced.deleted.length;
    if (remaining === 0) await storage.removeRecord(reduced.id);
    else await storage.saveRecord(reduced);
    log("Error");
    log("\tprevious install could not be fully removed; run tret uninstall <name>, then tret install <URL> --force");
    process.exit(1);
  }

  await storage.removeRecord(existing.id);
}

/** Joins two optional coverage reasons; either side may be absent. */
function combineReasons(existing: string | undefined, next: string): string {
  return existing === undefined || existing.length === 0 ? next : `${existing}; ${next}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
