import { LOGS_PATH, VERSION } from "../constants";
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// One log file per run under `~/.tret/logs/`. Writes are best-effort: a run never fails because its
// log could not be written. The file records the run header, the user-facing output, phase markers,
// and, on failure, the tail of the installer's output and any crash stack.

/** Newest run logs kept; older ones are deleted when a new run starts. */
const KEEP_RUNS = 50;

/** Run logs older than this are deleted when a new run starts. */
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;

/** Installer output lines kept for a failed run. */
const TAIL_LINES = 50;

/** Patterns whose matches are masked before any line reaches the file. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?(?:"[^"]*"|'[^']*'|[^\s"'&?#]+)/gi, "$1<redacted>"],
  [
    /\b((?:[\w.-]*[-_])?(?:token|secret|passwd|password|api[_-]?key|signature|access[_-]?key|credential)[\w.-]*|sig)(=|:\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s"'&?#]+)/gi,
    "$1$2<redacted>",
  ],
  [/\b(AWSAccessKeyId)(=|:\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s"'&?#]+)/gi, "$1$2<redacted>"],
  [/(https?:\/\/)[^\s/@]+@/gi, "$1<redacted>@"],
];

type ActiveRunLog = {
  path: string;
  lastPhase: string;
  /** The last installer output lines, kept in memory until the run ends. */
  tail: string[];
  /** Installer output that has not reached a newline yet. */
  pending: string;
};

let active: ActiveRunLog | undefined;

/**
 * Starts the log file for this run and writes its header. Returns the file path, or undefined when
 * the file cannot be created, in which case every later call is a no-op.
 */
export function openRunLog(argv: string[], homeDir = process.env.HOME ?? homedir()): string | undefined {
  try {
    const dir = join(homeDir, LOGS_PATH);
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const command = (argv[0] ?? "help").replace(/[^a-z0-9]/gi, "") || "run";
    const path = join(dir, `${stamp}-${command}-${randomUUID().slice(0, 6)}.log`);
    appendFileSync(path, "", { mode: 0o600 });
    pruneRunLogs(dir);

    active = { path, lastPhase: "start", tail: [], pending: "" };
    emit("run", `version=${VERSION} os=${platform()} arch=${arch()} pid=${process.pid} command="${argv.join(" ")}"`);
    return path;
  } catch {
    active = undefined;
    return undefined;
  }
}

/** Records the step the run has reached, so a failure report can say where it stopped. */
export function runLogPhase(name: string): void {
  if (!active) return;
  active.lastPhase = name;
  emit("phase", name);
}

/** Records lines of user-facing output. */
export function runLogLine(message: string): void {
  for (const line of message.split("\n")) emit("out", line);
}

/** Keeps the last lines of installer output for a failed run; nothing is written until the run ends. */
export function runLogOutput(chunk: Buffer): void {
  if (!active) return;
  const lines = `${active.pending}${chunk.toString()}`.split("\n");
  active.pending = lines.pop() ?? "";
  for (const line of lines) {
    active.tail.push(line.replace(/\r$/, ""));
    if (active.tail.length > TAIL_LINES) active.tail.shift();
  }
}

/**
 * Ends the run's log with its exit code. A failed run also gets the installer output tail. Returns
 * the file path when the run failed, so the caller can point the user at it. Safe to call again.
 */
export function closeRunLog(code: number): string | undefined {
  if (!active) return undefined;

  if (code !== 0 && active.tail.length > 0) {
    const tail = active.pending === "" ? active.tail : [...active.tail, active.pending];
    emit("output", "installer output (most recent lines):");
    for (const line of tail) emit("output", line);
  }
  emit("exit", `code=${code} last-phase=${active.lastPhase}`);

  const { path } = active;
  active = undefined;
  return code === 0 ? undefined : path;
}

/**
 * Records an uncaught error or rejection and exits, so no crash leaves the run without a log entry.
 * Also ends the log when the process exits by any other path, and points a failed run at its file.
 */
export function watchRunLog(): void {
  process.on("exit", (code) => {
    const path = closeRunLog(code);
    if (path !== undefined) writeSync(2, `\tdetails: ${path}\n`);
  });

  const onCrash = (error: unknown) => {
    const stack = error instanceof Error && error.stack ? error.stack : String(error);
    if (active) {
      emit("crash", `last-phase=${active.lastPhase}`);
      for (const line of stack.split("\n")) emit("crash", line);
    }
    process.stderr.write(`${stack}\n`);
    process.exit(1);
  };
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);
}

function emit(kind: string, text: string): void {
  if (!active) return;
  const time = new Date().toISOString().slice(11, 23);
  try {
    appendFileSync(active.path, `${time}  ${kind.padEnd(6)}  ${scrub(text)}\n`, { mode: 0o600 });
  } catch {
    // Best-effort: a log that cannot be written must not fail the run.
  }
}

function scrub(text: string): string {
  return SECRET_PATTERNS.reduce((masked, [pattern, replacement]) => masked.replace(pattern, replacement), text);
}

/** Deletes run logs past the retention limits. The newest file name sorts last, so it is always kept. */
function pruneRunLogs(dir: string): void {
  try {
    const now = Date.now();
    const names = readdirSync(dir)
      .filter((name) => name.endsWith(".log"))
      .sort()
      .reverse();
    names.forEach((name, index) => {
      const path = join(dir, name);
      if (index >= KEEP_RUNS || now - statSync(path).mtimeMs > KEEP_MS) rmSync(path, { force: true });
    });
  } catch {
    // Pruning is housekeeping; a failure here must not stop this run from logging.
  }
}
