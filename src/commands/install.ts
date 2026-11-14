import type { AbsolutePath, CaptureCompleteness, CaptureInfo, CaptureSegment, CaptureSettings, Diff, RecordV3 } from "../types";
import type { BackupPolicy, NormalizedEffects } from "../lib/capture/normalize";
import { DEFAULT_BACKUP_POLICY, FileStorage, collectUnreferencedBlobs } from "../lib/store";
import { EXIT_BLOCKED, EXIT_ERROR, EXIT_USAGE } from "../constants";
import { applyUninstallPlan, describeOutcome, reduceRecordForRetry } from "../lib/removal";
import { captureBackendFor, heuristicCaptureBackendFor } from "../lib/capture/current";
import { caseSensitiveForPaths, currentPlatform, installObservationRoots, processPrivilege } from "../lib/platform";
import { confirm, extractUrl, fetchScript, log, readLine, validateUrl } from "../lib/utilities";
import { delegatedRemovalBlocks, recordTarget } from "../lib/record-target";
import { describeManagedInstall, detectManagedInstall, withoutManagedInstallPaths } from "../lib/managed-install";
import { describeManagedPackage, detectManagedPackage, withoutManagedGlobalPaths } from "../lib/package-manager";
import { emitJson, emitJsonError, isJsonMode } from "../lib/json-output";
import { heuristicFallbackRoots, runCaptureFallback } from "../lib/capture/fallback";
import type { ApplianceOutcome } from "../lib/removal";
import type { CaptureBackend } from "../lib/capture/backend";
import type { CaptureSession } from "../lib/capture/backend";
import type { DurableOperation } from "../lib/operation-log";
import type { Journal } from "../lib/capture/events";
import type { NativeActionReceipt } from "../lib/native-action";
import type { Platform } from "../lib/platform";
import type { SessionCoverage } from "../lib/session";
import type { UninstallPlan } from "../lib/uninstall-planner";
import { adoptedEntries } from "../lib/adoption";
import { buildCleanupPlan } from "../lib/cleanup-plan";
import { diff } from "../lib/diff";
import { fail } from "../lib/failure";
import { formatCoverage } from "../lib/session";
import { formatUninstallPlan } from "../lib/uninstall-planner";
import { normalizeJournal } from "../lib/journal/normalize";
import { pickExecutable } from "../lib/executable";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { runInstaller } from "../lib/installer";
import { runLogPhase } from "../lib/runlog";
import { runStoreOperation } from "../lib/command-operation";
import { snapshot } from "../lib/snapshot";
import { unverifiedShellEdits } from "../lib/shellconfig";

/** Options for `install`; the command line uses the defaults, tests inject capture seams. */
export type InstallOptions = {
  /** Attach a bounded capture window; the `--no-capture` flag turns this off. */
  capture?: boolean;
  /** Capture backend override; defaults to the running platform's backend (D1/D7). */
  backend?: CaptureBackend;
  /** Observation roots override (D3); defaults to the platform's bounded install roots. */
  roots?: AbsolutePath[];
  /**
   * Capture-scope additions/exclusions from `--observe`/`--observe-exclude` (D3); applied on top of
   * the platform's roots so one install can cover an unusual installer without widening the defaults.
   */
  observe?: CaptureSettings["observe"];
  /**
   * Before-image backup policy (D2); off by default. When enabled, pre-existing file contents are
   * captured (within the size limit) and stored so uninstall can restore them.
   */
  backups?: BackupPolicy;
  /** Clock; injectable so a test can pin `installedAt` and the window timestamps. */
  now?: () => number;
  /** Display name supplied with `--name`; defaults to the installed executable's basename. */
  name?: string;
  /** Stable id of a record this install replaces; a tracked-tool update targets one record exactly. */
  replaceId?: string;
  /** Pre-fetched installer text and its sha256; a tracked-tool update validates before running. */
  script?: { text: string; sha256: string };
  /** Run the installer without the interactive confirmation prompt. */
  yes?: boolean;
  /**
   * Command name reported in JSON output; defaults to "install". A tracked-tool update passes
   * "update" so scripts can tell the two apart without inspecting the record's identity.
   */
  commandName?: string;
};

/**
 * Splits the capture-scope flags out of the `install` arguments. `--observe <path>` adds an absolute
 * path to this install's observation roots and `--observe-exclude <path>` drops one of the platform's
 * default roots, so a user can account for an installer that writes outside the defaults without
 * widening every capture. The value is resolved lexically to a canonical path, so a trailing slash
 * (shell completion) cannot leave the root itself uncovered. Returns the misuse message instead of
 * throwing; `index.ts` prints it in the usual Error shape.
 */
export function parseObserveFlags(
  args: string[],
): { scope: { include: AbsolutePath[]; exclude: AbsolutePath[] }; rest: string[] } | { error: string } {
  const include: AbsolutePath[] = [];
  const exclude: AbsolutePath[] = [];
  const rest: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg !== "--observe" && arg !== "--observe-exclude") {
      rest.push(arg);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) return { error: `${arg} requires an absolute path` };
    if (!value.startsWith("/")) return { error: `${arg} requires an absolute path: ${value}` };
    (arg === "--observe" ? include : exclude).push(resolve(value));
    index++;
  }

  return { scope: { include, exclude }, rest };
}

/**
 * Pulls the Tret-only `--name <value>` flag out of the pre-`--` arguments. The value is the record's
 * display name; the remaining arguments are still joined into the URL string for `extractUrl`.
 * Returns the misuse message instead of throwing, matching `parseObserveFlags`.
 */
export function extractNameFlag(args: string[]): { name: string | undefined; rest: string[] } | { error: string } {
  const rest: string[] = [];
  let name: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg !== "--name") {
      rest.push(arg);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || value.trim().length === 0) {
      return { error: "--name requires a display name" };
    }
    name = value;
    index++;
  }
  return { name, rest };
}

/**
 * Removes the Tret-only `--backup-size <bytes>` flag from the pre-`--` install arguments and
 * validates the value as a positive, safe integer number of bytes. It is the per-file limit for
 * the before-images this install captures: a file larger than the limit is still recorded as a
 * mutation or deletion, it just is not claimed restorable. A missing, non-numeric, zero, or
 * negative size is a usage error, so the message is returned instead of thrown and the CLI uses
 * its standard failure path.
 */
export function extractBackupSizeFlag(
  args: string[],
): { sizeLimitBytes: number | undefined; rest: string[] } | { error: string } {
  const rest: string[] = [];
  let sizeLimitBytes: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg !== "--backup-size") {
      rest.push(arg);
      continue;
    }
    if (sizeLimitBytes !== undefined) return { error: "--backup-size may only be provided once" };
    const value = args[index + 1];
    if (value === undefined) return { error: "--backup-size requires a positive integer number of bytes" };
    // Only plain digits count: "1.5", "1e6", "-1", and "0x10" are not byte counts.
    if (!/^\d+$/.test(value)) {
      return { error: `--backup-size requires a positive integer number of bytes: ${value}` };
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      return { error: `--backup-size requires a positive integer number of bytes: ${value}` };
    }
    sizeLimitBytes = parsed;
    index++;
  }
  return { sizeLimitBytes, rest };
}

export async function install(
  url?: string,
  force = false,
  scriptArgs: string[] = [],
  options: InstallOptions = {},
): Promise<void> {
  const clock = options.now ?? Date.now;
  const backups = options.backups ?? DEFAULT_BACKUP_POLICY;

  if (!url) {
    if (isJsonMode()) fail("install-usage", "install requires a URL in JSON mode", EXIT_USAGE);
    log("Paste the install command (curl ... | bash):");
    url = await readLine();
  }

  // The paste is a shell command like `curl -fsSL https://... | bash`, not a bare URL.
  const pasted = extractUrl(url);
  if (!pasted) fail("install-url", `no URL found in: ${url}`, EXIT_USAGE);
  url = pasted;

  const urlError = validateUrl(url);
  if (urlError) fail("install-url", urlError, EXIT_USAGE);

  if (!options.yes && (isJsonMode() || !process.stdin.isTTY)) {
    fail("install-consent", "pass --yes to run an installer without an interactive confirmation", EXIT_BLOCKED);
  }

  const storage = new FileStorage({ backups });
  if (!storage.inOperation) return runStoreOperation(storage, () => install(url, force, scriptArgs, options));
  let records: RecordV3[];
  try {
    records = await storage.loadRecords();
  } catch (error) {
    fail("install-records", `could not read the install records: ${message(error)}`);
  }

  // A tracked-tool update targets the record it already resolved; a plain install matches by URL.
  const existing =
    options.replaceId === undefined
      ? records.find((record) => record.url === url)
      : records.find((record) => record.id === options.replaceId);
  if (existing && !force) {
    const target = recordTarget(existing);
    const blocked = delegatedRemovalBlocks(target);
    if (blocked.length > 0) {
      fail("install-delegated-unverified", `${blocked.join("; ")}; previous install is unchanged`, EXIT_BLOCKED);
    }
    const blockedShell = unverifiedShellEdits(target.record);
    if (blockedShell.length > 0) {
      fail("install-shell-unverified", `shell edits have no supported edit provenance or before-image: ${blockedShell.join(", ")}; manual reconciliation is required; previous install is unchanged`, EXIT_BLOCKED);
    }
    fail(
      "install-exists",
      `${existing.name} is already installed (from ${existing.installedAt.slice(0, 10)}); use tret install <URL> --force to reinstall`,
    );
  }

  // Fetch and validate the replacement before a forced reinstall removes the current install. A
  // tracked-tool update hands in the script it already fetched and validated, so it is not fetched twice.
  runLogPhase("fetch-script");
  const fetched = options.script === undefined ? await fetchScript(url) : options.script;
  if (fetched === undefined) fail("install-fetch", `URL does not return a raw script file: ${url}`);
  const script = typeof fetched === "string" ? fetched : fetched.text;
  const scriptSha256 =
    typeof fetched === "string" ? new Bun.CryptoHasher("sha256").update(script).digest("hex") : fetched.sha256;
  if (existing?.scriptSha256 && existing.scriptSha256 !== scriptSha256) {
    log(`the script at ${url} changed since ${existing.name} was last installed`);
  }

  const platform = currentPlatform();
  // Every path the window can record sits under one of the observation roots, so the record's
  // single case flag is resolved from the roots themselves (D10). The same flag keys the capture
  // backend's path comparison, so its journal and normalization agree on path identity.
  const roots = options.roots ?? installObservationRoots(platform, options.observe);
  const caseSensitive = caseSensitiveForPaths(platform, roots);

  const recordId = options.replaceId ?? randomUUID();
  const provisional: RecordV3 = {
    id: recordId, name: recordDisplayName(options.name, existing?.name, undefined, url, scriptSha256),
    source: "install", url, installedAt: new Date(clock()).toISOString(), executable: "", scriptSha256,
    ...(scriptArgs.length ? { scriptArgs } : {}),
    captureSettings: { enabled: options.capture ?? true, backups, ...(options.observe ? { observe: options.observe } : {}) },
    capture: { backend: "pending", completeness: "partial", segments: [{ kind: "install", startedAt: new Date(clock()).toISOString(), partialReason: "operation not captured to completion" }] },
    privilege: processPrivilege(), caseSensitive, owned: [], mutated: [], deleted: [],
  };
  const execution = { recordId, roots, scriptSha256 };

  // Show the source and its identity before anything runs (plan 03 item 6). The preview is bounded,
  // so a long installer cannot flood the terminal; the full text stays in the run log.
  log(`installer script: ${url}`);
  log(`\tsha256 ${scriptSha256}`);
  for (const line of installerPreview(script)) log(line);
  log(
    "\tTret observes and records what this installer changes so you can remove it later; it does not sandbox the installer or prevent malware.",
  );

  // Noninteractive execution already required --yes above; interactive runs still confirm the script.
  if (!options.yes && !isJsonMode() && process.stdin.isTTY) {
    const answer = confirm("run this installer? [y/N]");
    if (answer === undefined) {
      fail("install-consent", "could not read a confirmation; pass --yes to run the installer", EXIT_BLOCKED);
    }
    if (!answer) {
      log("aborted; nothing was installed");
      return;
    }
  }

  // A --force reinstall is an uninstall then install: the old tool and its record go first through
  // the same verified planner an explicit uninstall uses, so no stale owned path survives it.
  let operation!: DurableOperation;
  if (existing && force) {
    runLogPhase("remove-previous");
    await removePrevious(storage, existing, records, async (plan) => {
      await storage.prepareCurrentFormat();
      operation = storage.operations.begin("replace", [existing]);
      operation = storage.operations.checkpoint(operation, {
        stage: "applying", checkpoint: provisional, execution,
        application: { plan, outcomes: [], nextAction: 0 },
      });
    }, (plan, outcomes, nextAction, native) => {
      operation = storage.operations.checkpoint(operation, { application: {
        ...operation.application, plan, outcomes, nextAction,
        ...(native ? { native: { ...operation.application?.native, [native.index]: native.receipt } } : {}),
      } });
    });
  } else {
    await storage.prepareCurrentFormat();
    operation = storage.operations.begin("install");
    operation = storage.operations.checkpoint(operation, { checkpoint: provisional, execution });
  }

  // The installer runs inside a bounded capture window. With capture on, the journal is the sole
  // effects source, so no global snapshot runs. `--no-capture` (or a backend that cannot attach)
  // falls back to the legacy snapshot/diff; its added paths are fingerprinted from disk at record
  // time, while mutations and deletions stay detect-only without before-images.
  runLogPhase("run-installer");
  const beforeRun = async (session?: CaptureSession) => {
    operation = storage.operations.checkpoint(operation, {
      pins: [...(session?.beforeImages?.keys() ?? [])],
      ...(session?.baseline ? { baseline: session.baseline } : {}),
    });
    for (const [id, bytes] of session?.beforeImages ?? []) {
      const stored = await storage.putBlob(bytes);
      if (stored.id !== id) throw new Error("capture before-image does not match its content address");
    }
    operation = storage.operations.checkpoint(operation, { stage: "running", unknownSince: new Date().toISOString() });
  };
  const window = await observeInstall(platform, script, scriptArgs, options, backups, roots, caseSensitive, beforeRun);
  const captured = window.journal ? {
    backend: window.journal.backend, completeness: window.journal.completeness,
    events: window.journal.events, ...(window.journal.partialReason ? { partialReason: window.journal.partialReason } : {}),
  } : { backend: "disabled", completeness: "partial" as const, events: [] };
  operation = storage.operations.checkpoint(operation, { stage: "captured", capture: captured, execution: { ...execution, exitCode: window.exitCode } });
  log(
    window.coverage
      ? `observed the install with ${formatCoverage(window.coverage)}`
      : "capture disabled for this install; no observation window was recorded",
  );

  const effects = buildEffects(window, caseSensitive, backups);

  // The tool name comes from the executable the install actually put on disk, not the URL or a
  // prompt; when the URL is already tracked, keep the name that install used rather than re-deriving.
  const executable = pickExecutable(effects.owned.map((entry) => entry.path));
  const name = recordDisplayName(options.name, existing?.name, executable, url, scriptSha256);
  const missingExecutable = executable === undefined;
  const effectCount = effects.owned.length + effects.mutated.length + effects.deleted.length;

  // A no-executable install that changed observed paths still keeps a partial record, so its files
  // are never untracked leftovers; one that changed nothing has nothing to record and fails as before.
  if (missingExecutable && effectCount === 0) {
    storage.operations.checkpoint(operation, { stage: "partial", reason: "installer added no executable; captured effects or an unknown interval remain" });
    fail("install-executable", `install script added no executable command: ${url}`);
  }

  const failureReason = missingExecutable ? "installer added no executable command" : undefined;
  const failed = window.exitCode !== 0 || missingExecutable;
  // A global package-manager install keeps its executable as a bin shim into shared state; record
  // the layout so cleanup reports the unresolved scope instead of touching shared state.
  // The shared tree itself is never owned: npm's prefix `lib` and bun's global root are shared by
  // every global install, so the capture drops what sits under the detected root.
  const managedBy = executable === undefined ? undefined : detectManagedPackage(executable, effects.owned);
  if (managedBy !== undefined) {
    effects.owned = withoutManagedGlobalPaths(effects.owned, managedBy, Bun.env.HOME);
    effects.mutated = withoutManagedGlobalPaths(effects.mutated, managedBy, Bun.env.HOME);
    effects.deleted = withoutManagedGlobalPaths(effects.deleted, managedBy, Bun.env.HOME);
  }

  // A first-party managed install (a marker file under an install root) keeps a `node_modules`
  // payload capture skips everywhere; own the launcher and the root's ancestors, but leave the root
  // and its payload visible as unresolved. Recognition cannot authorize recursive cleanup.
  const managedInstall = executable === undefined ? undefined : detectManagedInstall(executable, effects.owned);
  if (managedInstall !== undefined) {
    effects.owned = withoutManagedInstallPaths(effects.owned, managedInstall);
    effects.mutated = withoutManagedInstallPaths(effects.mutated, managedInstall);
    effects.deleted = withoutManagedInstallPaths(effects.deleted, managedInstall);
  }

  // Store the before-image bytes the window captured, then drop any restore claim storage did not
  // actually land, so the record never advertises a blob `getBlob` cannot return (D2). Runs after the
  // shared-state filter so a dropped path's before-image is never stored as an orphan blob.
  const record: RecordV3 = {
    // A tracked-tool update keeps the record's stable id, so a selector a script already holds
    // still resolves after the update; a fresh install gets a new id.
    id: recordId,
    name,
    source: "install",
    url,
    installedAt: new Date(clock()).toISOString(),
    // An empty path is the v3 representation for a partial record with no discoverable executable;
    // `list` shows it as partial and `uninstall <name>` can still remove its captured effects.
    executable: executable ?? "",
    scriptSha256,
    ...(scriptArgs.length === 0 ? {} : { scriptArgs }),
    captureSettings: {
      enabled: options.capture ?? true,
      backups,
      ...(options.observe === undefined ? {} : { observe: options.observe }),
    },
    capture: buildCapture(window, failed, clock, failureReason),
    privilege: processPrivilege(),
    caseSensitive,
    owned: effects.owned,
    mutated: effects.mutated,
    deleted: effects.deleted,
    ...(managedBy === undefined ? {} : { managedBy }),
    ...(managedInstall === undefined ? {} : { managedInstall }),
  };
  operation = storage.operations.checkpoint(operation, { checkpoint: record });
  await storeBeforeImages(effects, window.journal, storage, backups);
  runLogPhase("save-record");
  await storage.saveRecord(record);
  storage.operations.checkpoint(operation, { stage: failed ? "partial" : "completed", checkpoint: record });

  // A replacement dropped the previous record's claims, so its before-images may now be
  // unreferenced. Sweep after the new record is durable; the helper never fails this install.
  if (existing !== undefined) await collectUnreferencedBlobs();

  if (failed) {
    // A non-zero exit or missing executable keeps observed changes in a labeled partial record.
    log("Error");
    if (window.exitCode !== 0) log(`\tinstall script exited with code ${window.exitCode}: ${url}`);
    if (missingExecutable) log(`\tinstall script added no executable command: ${url}`);
    log(`\tkept a partial record for ${name}; inspect it with tret inspect ${name}, remove it with tret uninstall ${name}`);
    emitJsonError("install-partial", failureReason ?? `install script exited with code ${window.exitCode}`);
    process.exit(1);
  }

  log(`installed ${name}`);
  log(`\tobserved ${effects.owned.length} candidate additions; cleanup requires explicit object approval`);
  log(`\tmutated ${effects.mutated.length}`);
  log(`\tdeleted ${effects.deleted.length}`);
  if (managedBy !== undefined)
    log(
      `\tglobal package ${describeManagedPackage(managedBy)} requires manual reconciliation; automatic manager cleanup is blocked`,
    );
  if (managedInstall !== undefined)
    log(
      `\tmanaged install ${describeManagedInstall(managedInstall)} requires manual reconciliation; recursive cleanup is blocked`,
    );

  // The structured result a script reads; the human lines above went to the terminal (plan 03 item 5).
  if (isJsonMode()) {
    emitJson({
      ok: true,
      command: options.commandName ?? "install",
      tool: name,
      id: record.id,
      url,
      executable: record.executable,
      installedAt: record.installedAt,
      owned: effects.owned.length,
      mutated: effects.mutated.length,
      deleted: effects.deleted.length,
      capture: { backend: record.capture.backend, completeness: record.capture.completeness },
    });
  }
}

/**
 * Lines previewing the fetched installer so the user can see what will run (plan 03 item 6). The
 * preview is bounded: a long script shows its head plus a count of the lines left out.
 */
export function installerPreview(script: string, maxLines = 20): string[] {
  const lines = script.split("\n");
  const shown = lines.slice(0, maxLines).map((line) => `\t${line}`);
  if (lines.length > maxLines) shown.push(`\t... ${lines.length - maxLines} more lines`);
  return shown;
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
 * best-effort for `install`: the shared pre-run fallback tries the platform tracer, then the
 * platform's labeled heuristic backend (`linux-heuristic`/`macos-heuristic`), and only a window that
 * never starts keeps the legacy snapshot/diff. The installer runs exactly once either way, and a
 * failed capture close is reported as partial coverage by the session rather than re-running the
 * script. `caseSensitive` is the record-wide probe (D10), handed to both backends so their path keys
 * match the record and journal normalization.
 */
async function observeInstall(
  platform: Platform,
  script: string,
  scriptArgs: string[],
  options: InstallOptions,
  backups: BackupPolicy,
  roots: AbsolutePath[],
  caseSensitive: boolean,
  beforeRun: (session?: CaptureSession) => Promise<void>,
): Promise<InstallWindow> {
  if (!(options.capture ?? true)) {
    const before = snapshot();
    await beforeRun();
    const exitCode = await runInstaller(script, scriptArgs);
    return { exitCode, fallback: diff(before, snapshot()) };
  }

  const attempt = await runCaptureFallback({
    primary: options.backend ?? captureBackendFor(platform, caseSensitive),
    fallback: heuristicCaptureBackendFor(platform, caseSensitive),
    // The installer is spawned as a child of this process, so observing this pid covers it.
    pid: process.pid,
    privilege: processPrivilege(),
    roots,
    fallbackRoots: heuristicFallbackRoots(roots),
    backups,
    beforeRun,
    run: () => runInstaller(script, scriptArgs),
    onPrimaryFailure: (error) =>
      log(`capture unavailable (${message(error)}); observing the install with a heuristic window`),
    onFallbackFailure: (error) =>
      log(`heuristic capture unavailable (${message(error)}); the install runs without an observation window`),
  });

  if (attempt.session === undefined) {
    // Both backends failed before the installer started, so it has not run yet. Keep the legacy
    // snapshot/diff path for the install instead of running it unwatched with no observation at all.
    const before = snapshot();
    await beforeRun();
    const exitCode = await runInstaller(script, scriptArgs);
    return { exitCode, fallback: diff(before, snapshot()) };
  }

  if (attempt.session.error !== undefined) throw attempt.session.error;
  return {
    exitCode: attempt.session.value ?? 1,
    coverage: attempt.session.coverage,
    journal: attempt.session.journal,
  };
}

/**
 * The record's display name, in the documented precedence order: an explicit `--name`, the name of
 * the record this install replaces, the installed executable's basename, the final non-empty URL
 * path segment with a trailing `.sh` removed, and finally a script-hash prefix. The last fallback
 * keeps a no-executable install nameable even when its URL has no usable path; record ids remain
 * the unambiguous selector when two fallback names collide.
 */
export function recordDisplayName(
  provided: string | undefined,
  replaced: string | undefined,
  executable: AbsolutePath | undefined,
  url: string,
  scriptSha256: string,
): string {
  if (provided !== undefined) return provided;
  if (replaced !== undefined) return replaced;
  const basename = executable?.split("/").pop();
  if (basename !== undefined && basename.length > 0) return basename;
  const segment = finalUrlSegment(url);
  if (segment !== undefined) return segment;
  return `partial-${scriptSha256.slice(0, 12)}`;
}

/** The last non-empty URL path segment, without a trailing `.sh`; undefined when the URL has none. */
function finalUrlSegment(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  const segment = pathname
    .split("/")
    .filter((part) => part.length > 0)
    .at(-1);
  if (segment === undefined) return undefined;
  const name = segment.replace(/\.sh$/, "");
  return name.length === 0 ? undefined : name;
}

/**
 * Normalizes the captured journal into effects. A fallback diff has no journal, so its added paths
 * are fingerprinted from their on-disk state at record time: that is the only evidence a later
 * uninstall can verify, and it keeps `--no-capture` installs removable without relaxing the
 * planner's rule for records that genuinely lack a fingerprint. Mutations and deletions stay
 * detect-only because the legacy diff captured no before-image.
 */
function buildEffects(window: InstallWindow, caseSensitive: boolean, backups: BackupPolicy): NormalizedEffects {
  if (window.journal) {
    return normalizeJournal({
      journal: window.journal,
      backups,
      caseSensitive,
      // Restorable only for bytes the window actually captured; anything else stays detect-only.
      availableBeforeImages: new Set(window.journal.beforeImages?.keys() ?? []),
    });
  }

  const changes = window.fallback ?? { added: [], edited: [], deleted: [] };
  return {
    owned: adoptedEntries(changes.added),
    mutated: changes.edited.map((path) => ({ path })),
    deleted: changes.deleted.map((path) => ({ path })),
    diagnostics: [],
  };
}

/**
 * Persists the before-image bytes the capture window collected and drops any restore claim whose
 * blob was not actually stored, so a record never advertises a restore `getBlob` cannot perform
 * (D2, plan section 9 item 5). Off by default: with backups disabled there is nothing captured.
 */
async function storeBeforeImages(
  effects: NormalizedEffects,
  journal: Journal | undefined,
  storage: FileStorage,
  backups: BackupPolicy,
): Promise<void> {
  const images = journal?.beforeImages;
  for (const entry of [...effects.mutated, ...effects.deleted]) {
    const id = entry.beforeBlob;
    if (id === undefined) continue;
    const bytes = backups.enabled ? images?.get(id) : undefined;
    if (bytes === undefined) {
      delete entry.beforeBlob;
      continue;
    }
    const stored = await storage.captureBeforeImage(bytes);
    if (stored === undefined || stored.id !== id) delete entry.beforeBlob;
  }
}

/** Builds the record's capture info; a failed install or missing executable is labeled partial (D6). */
function buildCapture(window: InstallWindow, failed: boolean, clock: () => number, failureReason?: string): CaptureInfo {
  const at = new Date(clock()).toISOString();
  const segment: CaptureSegment = window.coverage
    ? { ...window.coverage.segment }
    : { kind: "install", startedAt: at, endedAt: at, partialReason: "capture disabled for this install" };
  let completeness: CaptureCompleteness = window.coverage?.completeness ?? "heuristic";

  if (failed) {
    completeness = "partial";
    const reasons = [
      ...(window.exitCode === 0 ? [] : [`installer exited with code ${window.exitCode}`]),
      ...(failureReason === undefined ? [] : [failureReason]),
    ];
    if (reasons.length > 0) segment.partialReason = combineReasons(segment.partialReason, reasons.join("; "));
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
async function removePrevious(
  storage: FileStorage,
  existing: RecordV3,
  records: RecordV3[],
  beforeApply: (plan: UninstallPlan) => Promise<void>,
  checkpoint: (plan: UninstallPlan, outcomes: ApplianceOutcome[], nextAction: number, native?: { index: number; receipt: NativeActionReceipt }) => void,
): Promise<void> {
  log(`reinstalling ${existing.name}: removing the previous install first`);
  const { target: delegated, plan, conflicts, blocked, blockedShell } = await buildCleanupPlan(existing, records, {
    force: true, getBlob: (id) => storage.getBlob(id),
  });
  const target = delegated.record;
  if (conflicts.length) fail("install-delegated-conflict", conflicts.join("\n\t"), EXIT_BLOCKED);
  if (blocked.length) fail("install-delegated-unverified", `${blocked.join("; ")}; previous install is unchanged`, EXIT_BLOCKED);
  if (blockedShell.length) fail("install-shell-unverified", `shell edits have no supported edit provenance or before-image: ${blockedShell.join(", ")}; manual reconciliation is required; previous install is unchanged`, EXIT_BLOCKED);

  // Show the same labeled plan as uninstall before a forced reinstall removes anything (D11).
  for (const line of formatUninstallPlan(plan, "apply")) {
    log(`\t${line}`);
  }

  // A conflict force cannot resolve aborts before removing or restoring files.
  // The previous install and its record are left exactly as they were,
  // so a replacement never deletes the old executable and then strands a parent-directory record.
  if (plan.incomplete) {
    fail("install-previous-blocked", "previous install is unchanged; resolve the conflicts above, then retry the forced reinstall", EXIT_BLOCKED);
  }
  if (plan.requiresSudo && process.getuid?.() !== 0) fail("install-privilege", "previous cleanup requires root privileges; previous install is unchanged", EXIT_BLOCKED);

  await beforeApply(plan);
  let completed: ApplianceOutcome[] = [];
  const result = await applyUninstallPlan(plan, {
    storage,
    beforeAction: async (index) => checkpoint(plan, completed, index),
    afterAction: async (index, outcomes) => {
      completed = [...outcomes];
      checkpoint(plan, completed, index + 1);
    },
    nativeCheckpoint: async (index, receipt) => checkpoint(plan, completed, index, { index, receipt }),
  });

  const announced = new Set(
    plan.actions
      .filter((action) => action.action === "conflict" || action.action === "skip" || action.action === "detected")
      .map((action) => action.path),
  );
  for (const outcome of result.outcomes) {
    if (
      (outcome.outcome === "conflict" || outcome.outcome === "skipped" || outcome.outcome === "detected") &&
      announced.has(outcome.path)
    )
      continue;
    log(`\t${describeOutcome(outcome)}`);
  }

  const incomplete = result.incomplete;
  if (incomplete) {
    const reduced = reduceRecordForRetry(target, result);
    const remaining = reduced.owned.length + reduced.mutated.length + reduced.deleted.length;
    if (remaining === 0) await storage.removeRecord(reduced.id, reduced.revision);
    else await storage.saveRecord(reduced);
    fail("install-previous-incomplete", "previous install could not be fully removed; run tret recover to inspect the interrupted operation and reconcile retained files before planning cleanup again", EXIT_ERROR);
  }

  await storage.removeRecord(existing.id, existing.revision);
}

/** Joins two optional coverage reasons; either side may be absent. */
function combineReasons(existing: string | undefined, next: string): string {
  return existing === undefined || existing.length === 0 ? next : `${existing}; ${next}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
