import { CaptureBudget, CaptureBudgetError } from "../budget";
import type { TracerRecord, TracerResult } from "./raw";
import { inRoots, normalizeAbsolutePath } from "./paths";
import type { AbsolutePath } from "../../../types";

/**
 * Pure parser for `strace` output (`-f -ttt -y -o <file>`, one line per syscall). It turns syscall
 * lines into `TracerRecord`s; `reconstruct.ts` then inspects the filesystem for before/after
 * metadata. Parsing is separated from spawning so the exact same code is exercised on hosts without
 * a Linux ptrace tracer (plan section 8, phase 4 conformance tests).
 *
 * Coverage caveats the parser reports instead of hiding:
 * - A relative path is resolved against the `-y` annotation strace printed for its dirfd — including
 *   `AT_FDCWD</dir>`, which pins the tracee's working directory at that syscall. Only when strace
 *   printed no usable annotation does the parser use observed process/descriptor state; a relative path
 *   with no known directory at all is dropped with a diagnostic.
 * - Unknown fds in `write`-family calls become a diagnostic (the fd map is reset when strace cannot
 *   report an `open` we parsed, for example a write inherited across a `fork` we did not trace).
 * - Syscalls that can change content or metadata in a way the journal cannot represent (`mmap`
 *   `PROT_WRITE`, `sendfile`, `copy_file_range`, `fallocate`, xattr, chown, hard links) are reported
 *   as `unsupported` so completeness is lowered rather than overstated.
 */

/** Options that affect relative-path resolution and which syscalls are considered in scope. */
export type ParseStraceOptions = {
  budget?: CaptureBudget;
  /**
   * Initial cwd of the attached root process. Children require observed inheritance; unknown
   * numeric directory descriptors never fall back to cwd. A `-y` annotation always wins.
   */
  cwd?: AbsolutePath;
  rootPid?: number;
  /**
   * Only records whose path falls under one of these roots after lexical `.`/`..` normalization are
   * kept. Empty or omitted means "keep everything", which the backend uses when it wants to
   * attribute the whole traced tree. The filter is lexical; `reconstruct.ts` resolves symlinked
   * components against the real filesystem before a path is recorded.
   */
  roots?: AbsolutePath[];
  /** Tracer-owned raw staging never becomes installer payload, including with broad /tmp roots. */
  excludedRoots?: AbsolutePath[];
};

export function parseStraceOutput(text: string, options: ParseStraceOptions = {}): TracerResult {
  const stream = new StraceStreamParser(options);
  stream.write(Buffer.from(text));
  return stream.finish();
}

/** Append-only parser: partial lines, UTF8, unfinished calls and descriptor maps survive checkpoints. */
export class StraceStreamParser {
  private readonly parser: StraceParser;
  private readonly budget: CaptureBudget;
  private readonly decoder = new TextDecoder();
  private pending = "";
  private failed = false;
  constructor(options: ParseStraceOptions = {}) {
    this.budget = options.budget ?? new CaptureBudget();
    this.budget.ensurePhase();
    this.parser = new StraceParser({ ...options, budget: this.budget });
  }
  write(bytes: Uint8Array): void {
    if (this.failed) return;
    this.consume(() => {
      this.budget.consume("auditBytes", bytes.byteLength);
      this.pending += this.decoder.decode(bytes, { stream: true });
      let end;
      while ((end = this.pending.indexOf("\n")) !== -1) {
        const line = this.pending.slice(0, end);
        this.pending = this.pending.slice(end + 1);
        this.parser.feed(line);
      }
    });
  }
  snapshot(): TracerResult { return this.parser.result(); }
  finish(): TracerResult {
    this.consume(() => {
      this.pending += this.decoder.decode();
      if (this.pending) this.parser.feed(this.pending);
      this.pending = "";
    });
    this.parser.finish();
    return this.snapshot();
  }
  private consume(work: () => void): void {
    if (this.failed) return;
    try { work(); }
    catch (error) {
      if (!(error instanceof CaptureBudgetError)) throw error;
      this.failed = true;
      this.parser.diagnose(error.message);
    }
  }
}

/** Syscalls that are relevant to the journal, mapped to how they should be interpreted. */
const UNSUPPORTED_SYSCALLS = new Set([
  "mmap",
  "mmap2",
  "msync",
  "sendfile",
  "sendfile64",
  "copy_file_range",
  "splice",
  "fallocate",
  "chown",
  "lchown",
  "fchown",
  "fchownat",
  "setxattr",
  "lsetxattr",
  "fsetxattr",
  "removexattr",
  "lremovexattr",
  "fremovexattr",
  "mknod",
  "mknodat",
  "mkfifo",
  "mkfifoat",
  "link",
  "linkat",
  "utimensat",
  "utime",
  "utimes",
]);

type Descriptor = { kind: "named" | "path-only" | "unnamed"; path?: AbsolutePath; closeOnExec: boolean };
type ProcessState = { fds: Map<number, Descriptor>; cwd: { path?: AbsolutePath } };

type Pending = { at: number; pid?: number; syscall: string; args: string };

class StraceParser {
  private readonly options: ParseStraceOptions;
  private readonly records: TracerRecord[] = [];
  private readonly unsupported = new Set<string>();
  private readonly diagnostics: string[] = [];
  private readonly pending = new Map<string, Pending>();
  /** Open file descriptors per pid, so a `write` can be tied back to a path. */
  private readonly processes = new Map<string, ProcessState>();
  private rootKey?: string;
  private seededRoot = false;
  private readonly seenUnsupported = new Set<string>();

  constructor(options: ParseStraceOptions) {
    this.options = options;
    this.rootKey = options.rootPid === undefined ? undefined : pidKey(options.rootPid);
  }

  feed(rawLine: string): void {
    this.options.budget?.consume("auditLines", 1);
    this.options.budget?.consume("metadataBytes", Buffer.byteLength(rawLine) + 256);
    const line = rawLine.replace(/\r$/, "").trimEnd();
    if (line.length === 0) return;

    const prefix = stripPrefix(line);
    if (prefix.rest.length === 0) return;
    if (/^\+\+\+ (?:exited|killed)/.test(prefix.rest)) {
      this.processes.delete(pidKey(prefix.pid));
      this.pending.delete(pidKey(prefix.pid));
      return;
    }
    if (prefix.rest.includes("superseded by execve")) {
      this.processes.clear();
      this.diagnose("exec changed thread identity; inherited process state is unknown");
      return;
    }

    const resumed = /^<\.\.\.\s+(\w+)\s+resumed>(.*)$/.exec(prefix.rest);
    if (resumed) {
      const key = pidKey(prefix.pid);
      const pending = this.pending.get(key);
      const syscall = resumed[1] ?? "";
      const tail = resumed[2] ?? "";
      if (!pending || pending.syscall !== syscall) {
        if (syscall === "execve" || syscall === "execveat") this.processes.delete(key);
        this.diagnose(`resumed syscall without a matching unfinished line: ${syscall}`);
        return;
      }
      this.pending.delete(key);
      const { args, ret } = resumeArgs(pending.args, tail);
      this.handleCall(pending.at, prefix.pid ?? pending.pid, syscall, args, ret);
      return;
    }

    const call = splitCall(prefix.rest);
    if (!call) return;

    if (call.unfinished) {
      this.pending.set(pidKey(prefix.pid), {
        at: prefix.at,
        pid: prefix.pid,
        syscall: call.syscall,
        args: call.args,
      });
      return;
    }

    this.handleCall(prefix.at, prefix.pid, call.syscall, call.args, call.ret);
  }

  /** Flushes dangling unfinished syscalls as coverage gaps. */
  finish(): void {
    for (const pending of this.pending.values()) {
      this.diagnose(`unfinished syscall was never resumed: ${pending.syscall}`);
    }
    this.pending.clear();
  }

  result(): TracerResult {
    return {
      records: this.records.slice(),
      ...(this.options.excludedRoots ? { excludedRoots: this.options.excludedRoots } : {}),
      unsupported: [...this.unsupported].sort(),
      diagnostics: this.diagnostics.slice(),
    };
  }

  diagnose(reason: string): void {
    const bounded = reason.slice(0, 1024);
    if (this.diagnostics.length < 32 && !this.diagnostics.includes(bounded)) this.diagnostics.push(bounded);
  }

  private emit(record: TracerRecord): void {
    const paths = record.op === "rename" ? [record.from, record.to] : "path" in record && record.path ? [record.path] : [];
    if (record.op !== "rename" && paths.some(path => this.options.excludedRoots?.some(root => path === root || path.startsWith(root + "/")))) return;
    this.options.budget?.consume("metadataBytes", Buffer.byteLength(JSON.stringify(record)) + 128);
    this.records.push(record);
  }

  private handleCall(at: number, pid: number | undefined, syscall: string, argsBody: string, ret: string): void {
    const args = splitArgs(argsBody);
    const failed = ret.startsWith("-1") || ret.startsWith("-");
    this.processState(pid);

    // `mmap` is only a journal gap when it is a shared, writable, file-backed mapping; ordinary
    // anonymous allocations would otherwise mark almost every process as incomplete.
    if (syscall === "mmap" || syscall === "mmap2") {
      if (!failed && isSharedWritableFileMap(args)) {
        this.markUnsupported(syscall, undefined);
        this.emit({ op: "unsupported", at, pid, syscall, reason: unsupportedReason(syscall) });
      }
      return;
    }

    if (UNSUPPORTED_SYSCALLS.has(syscall)) {
      // A successful unsupported syscall may have changed content the journal cannot see.
      if (!failed) {
        this.markUnsupported(syscall, undefined);
        this.emit({ op: "unsupported", at, pid, syscall, reason: unsupportedReason(syscall) });
      }
      return;
    }

    switch (syscall) {
      case "chdir":
        if (!failed) this.setCwd(pid, this.resolvePath(args[0], pid, true));
        return;
      case "fchdir":
        if (!failed) {
          const descriptor = this.descriptor(pid, args[0]);
          this.setCwd(pid, descriptor?.kind === "unnamed" ? undefined : descriptor?.path);
          if (!this.processState(pid).cwd.path) this.diagnose("fchdir target is unknown");
        }
        return;
      case "fork": case "vfork": case "clone": case "clone3":
        if (!failed) this.inheritProcess(pid, syscall, args, ret);
        return;
      case "execve": case "execveat":
        if (!failed) {
          const state = this.processState(pid);
          this.options.budget?.consume("metadataBytes", state.fds.size * 96 + 256);
          state.fds = new Map([...state.fds].filter(([, descriptor]) => !descriptor.closeOnExec));
        }
        return;
      case "fcntl":
        if (!failed) this.handleFcntl(pid, args, ret);
        return;
      case "open":
      case "openat":
      case "openat2":
      case "creat":
        if (!failed) this.handleOpen(at, pid, syscall, args, ret);
        return;
      case "write":
      case "pwrite64":
      case "writev":
      case "pwritev":
        if (!failed) this.handleWrite(at, pid, args);
        return;
      case "truncate":
        if (!failed) this.emitWrite(at, pid, this.resolvePath(args[0], pid));
        return;
      case "ftruncate":
        if (!failed) this.emitWrite(at, pid, this.resolveFd(pid, args[0]));
        return;
      case "rename":
        if (!failed) this.emitRename(at, pid, this.resolvePath(args[0], pid, true), this.resolvePath(args[1], pid, true));
        return;
      case "renameat":
        if (!failed)
          this.emitRename(at, pid, this.resolvePathAt(args[0], args[1], pid, true), this.resolvePathAt(args[2], args[3], pid, true));
        return;
      case "renameat2":
        if (!failed)
          this.emitRename(at, pid, this.resolvePathAt(args[0], args[1], pid, true), this.resolvePathAt(args[2], args[3], pid, true), args[4]);
        return;
      case "unlink":
        if (!failed) this.emitUnlink(at, pid, this.resolvePath(args[0], pid));
        return;
      case "unlinkat": {
        if (failed) return;
        const path = this.resolvePathAt(args[0], args[1], pid);
        const flags = args[2] ?? "0";
        if (flags.includes("AT_REMOVEDIR")) this.emitRmdir(at, pid, path);
        else this.emitUnlink(at, pid, path);
        return;
      }
      case "chmod":
        if (!failed) this.emitChmod(at, pid, this.resolvePath(args[0], pid), args[1]);
        return;
      case "fchmod":
        if (!failed) this.emitChmod(at, pid, this.resolveFd(pid, args[0]), args[1]);
        return;
      case "fchmodat":
      case "fchmodat2":
        if (!failed) this.emitChmod(at, pid, this.resolvePathAt(args[0], args[1], pid), args[2]);
        return;
      case "symlink":
        if (!failed) this.emitSymlink(at, pid, this.resolvePath(args[1], pid), decodeLinkTarget(args[0]));
        return;
      case "symlinkat":
        if (!failed) this.emitSymlink(at, pid, this.resolvePathAt(args[1], args[2], pid), decodeLinkTarget(args[0]));
        return;
      case "mkdir":
        if (!failed) this.emitMkdir(at, pid, this.resolvePath(args[0], pid), args[1]);
        return;
      case "mkdirat":
        if (!failed) this.emitMkdir(at, pid, this.resolvePathAt(args[0], args[1], pid), args[2]);
        return;
      case "rmdir":
        if (!failed) this.emitRmdir(at, pid, this.resolvePath(args[0], pid));
        return;
      case "close": {
        const pidMap = this.processes.get(pidKey(pid))?.fds;
        const fd = fdNumber(args[0]);
        if (pidMap && fd !== undefined) pidMap.delete(fd);
        return;
      }
      case "dup":
      case "dup2":
      case "dup3": {
        if (failed) return;
        const to = fdNumber(ret);
        if (to === undefined) return;
        const source = this.descriptor(pid, args[0]);
        if (syscall === "dup2" && fdNumber(args[0]) === to) return;
        this.fdMap(pid).delete(to);
        if (source) this.fdMap(pid).set(to, { ...source, closeOnExec: syscall === "dup3" && /O_CLOEXEC|0x80000|524288/.test(args[2] ?? "") });
        return;
      }
      default:
        return;
    }
  }

  private handleOpen(at: number, pid: number | undefined, syscall: string, args: string[], ret: string): void {
    let path: AbsolutePath | undefined;
    let flags: string;
    if (syscall === "creat") {
      path = this.resolvePath(args[0], pid);
      flags = "O_CREAT|O_WRONLY|O_TRUNC";
    } else if (syscall === "open") {
      path = this.resolvePath(args[0], pid);
      flags = args[1] ?? "";
    } else {
      path = this.resolvePathAt(args[0], args[1], pid);
      flags = args[2] ?? "";
    }
    const fd = fdFromReturn(ret);
    if (fd !== undefined) this.fdMap(pid).delete(fd);

    let mode = parseMode(args[args.length - 1]);
    let constrained = false;
    if (syscall === "openat2") {
      const how = openHow(args[2]);
      mode = parseMode(how?.mode);
      flags = how?.flags ?? "";
      constrained = !how || !/^(?:0+|0x0+)$/.test(how.resolve);
      if (constrained) {
        this.diagnose("openat2 resolution or structure is not fully decoded; only an annotated result can be observed without creation proof");
        const actual = fdAnnotation(ret);
        path = actual === undefined ? undefined : normalizeRoot(actual, this.options);
      }
    }
    const decoded = openFlags(flags);
    if (decoded.kind === "unnamed") {
      if (fd !== undefined) this.fdMap(pid).set(fd, { kind: "unnamed", closeOnExec: decoded.closeOnExec });
      if (path !== undefined) this.diagnose("unnamed temporary descriptor observed; no named-path effect is inferred");
      return;
    }
    if (fd !== undefined && (path !== undefined || decoded.kind === "path-only"))
      this.fdMap(pid).set(fd, { kind: decoded.kind, path, closeOnExec: decoded.closeOnExec });
    if (path === undefined) return;
    if (!decoded.known) this.diagnose("open flags could not be fully decoded; creation and truncation remain unknown");
    this.emit({
      op: "open",
      at,
      pid,
      path,
      created: decoded.created,
      ...(decoded.created && decoded.exclusive && !constrained ? { exclusive: true } : {}),
      truncated: decoded.truncated,
      mode,
    });
  }

  private handleWrite(at: number, pid: number | undefined, args: string[]): void {
    const path = this.resolveFd(pid, args[0]);
    this.emitWrite(at, pid, path);
  }

  private emitWrite(at: number, pid: number | undefined, path: AbsolutePath | undefined): void {
    if (path === undefined) return;
    this.emit({ op: "write", at, pid, path });
  }

  private emitRename(at: number, pid: number | undefined, from: AbsolutePath | undefined, to: AbsolutePath | undefined, flags = "0"): void {
    if (from === undefined || to === undefined) return;
    if (!normalizeRoot(from, this.options) && !normalizeRoot(to, this.options)) return;
    const flag = flags.trim();
    const numeric = /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(flag) ? Number(flag) : undefined;
    const semantics = flag === "RENAME_EXCHANGE" || numeric === 2 ? "exchange" :
      flag === "RENAME_NOREPLACE" || numeric === 1 || numeric === 0 ? undefined : "uncertain";
    this.emit({ op: "rename", at, pid, from, to, ...(semantics ? { semantics } : {}),
      ...(flag === "RENAME_NOREPLACE" || numeric === 1 ? { noReplace: true } : {}) });
  }

  private emitUnlink(at: number, pid: number | undefined, path: AbsolutePath | undefined): void {
    if (path === undefined) return;
    this.emit({ op: "unlink", at, pid, path });
  }

  private emitRmdir(at: number, pid: number | undefined, path: AbsolutePath | undefined): void {
    if (path === undefined) return;
    this.emit({ op: "rmdir", at, pid, path });
  }

  private emitChmod(at: number, pid: number | undefined, path: AbsolutePath | undefined, rawMode: string | undefined): void {
    if (path === undefined) return;
    const mode = parseMode(rawMode);
    if (mode === undefined) return;
    this.emit({ op: "chmod", at, pid, path, mode });
  }

  private emitSymlink(
    at: number,
    pid: number | undefined,
    path: AbsolutePath | undefined,
    target: AbsolutePath | undefined,
  ): void {
    if (path === undefined || target === undefined) return;
    this.emit({ op: "symlink", at, pid, path, target });
  }

  private emitMkdir(at: number, pid: number | undefined, path: AbsolutePath | undefined, rawMode: string | undefined): void {
    if (path === undefined) return;
    this.emit({ op: "mkdir", at, pid, path, mode: parseMode(rawMode) });
  }

  private markUnsupported(syscall: string, path: AbsolutePath | undefined): void {
    const key = path === undefined ? syscall : `${syscall}:${path}`;
    if (this.seenUnsupported.has(key)) return;
    this.seenUnsupported.add(key);
    this.unsupported.add(syscall);
  }

  private processState(pid: number | undefined): ProcessState {
    const key = pidKey(pid);
    let state = this.processes.get(key);
    if (!state) {
      this.rootKey ??= key;
      const initial = key === this.rootKey && !this.seededRoot;
      if (initial) this.seededRoot = true;
      state = { fds: new Map(), cwd: { path: initial ? this.options.cwd : undefined } };
      this.processes.set(key, state);
    }
    return state;
  }

  private setCwd(pid: number | undefined, path: string | undefined): void {
    if (path !== undefined) this.options.budget?.consume("metadataBytes", Buffer.byteLength(path));
    this.processState(pid).cwd.path = path;
  }

  private fdMap(pid: number | undefined): Map<number, Descriptor> { return this.processState(pid).fds; }

  private descriptor(pid: number | undefined, raw: string | undefined): Descriptor | undefined {
    const fd = fdNumber(raw);
    const known = fd === undefined ? undefined : this.fdMap(pid).get(fd);
    if (known && known.kind !== "named") return known;
    const annotation = fdAnnotation(raw);
    if (annotation !== undefined) {
      const path = normalizeRoot(annotation, this.options);
      return path === undefined ? undefined : { kind: "named", path, closeOnExec: known?.closeOnExec ?? false };
    }
    return known;
  }

  private resolveFd(pid: number | undefined, raw: string | undefined): AbsolutePath | undefined {
    const descriptor = this.descriptor(pid, raw);
    return descriptor?.kind === "named" ? descriptor.path : undefined;
  }

  private inheritProcess(pid: number | undefined, syscall: string, args: string[], ret: string): void {
    const child = fdNumber(ret);
    if (child === undefined || child <= 0) return;
    const key = pidKey(child);
    if (this.processes.has(key)) {
      this.diagnose("child observed before fork completion; inherited state remains unknown");
      return;
    }
    const parent = this.processState(pid);
    let flags = "0";
    if (syscall === "clone") flags = args.find(arg => arg.startsWith("flags="))?.slice(6) ?? "unknown";
    if (syscall === "clone3") flags = args[0]?.startsWith("{") && args[0].endsWith("}") ?
      splitArgs(args[0].slice(1, -1)).find(arg => arg.startsWith("flags="))?.slice(6) ?? "unknown" : "unknown";
    const sharing = cloneSharing(flags);
    if (!sharing) {
      this.processes.set(key, { fds: new Map(), cwd: {} });
      this.diagnose("process clone flags were not decoded; inherited state is unknown");
      return;
    }
    this.options.budget?.consume("metadataBytes", sharing.files ? 256 : parent.fds.size * 64 + 256);
    this.processes.set(key, { fds: sharing.files ? parent.fds : new Map(parent.fds), cwd: sharing.fs ? parent.cwd : { ...parent.cwd } });
  }

  private handleFcntl(pid: number | undefined, args: string[], ret: string): void {
    const command = args[1];
    if (command === "F_DUPFD" || command === "F_DUPFD_CLOEXEC") {
      const to = fdNumber(ret), source = this.descriptor(pid, args[0]);
      if (to !== undefined) {
        this.fdMap(pid).delete(to);
        if (source) this.fdMap(pid).set(to, { ...source, closeOnExec: command === "F_DUPFD_CLOEXEC" });
      }
    } else if (command === "F_SETFD") {
      const fd = fdNumber(args[0]), source = this.descriptor(pid, args[0]);
      if (fd === undefined) return;
      if (args[2] === "FD_CLOEXEC" || args[2] === "1" || args[2] === "0x1" || args[2] === "0") {
        if (source) this.fdMap(pid).set(fd, { ...source, closeOnExec: args[2] !== "0" });
      } else { this.fdMap(pid).delete(fd); this.diagnose("descriptor close-on-exec flags are unknown"); }
    }
  }

  private resolvePath(raw: string | undefined, pid?: number, unscoped = false): AbsolutePath | undefined {
    if (raw === undefined) return undefined;
    const value = decodeStraceString(raw);
    if (value === undefined) return undefined;
    return this.absolute(value, undefined, pid, unscoped);
  }

  /** Resolves `(dirfd, path)` pairs, honoring an annotated dirfd and `AT_FDCWD`. */
  private resolvePathAt(dirfd: string | undefined, raw: string | undefined, pid: number | undefined, unscoped = false): AbsolutePath | undefined {
    if (raw === undefined) return undefined;
    const value = decodeStraceString(raw);
    if (value === undefined) return undefined;
    return this.absolute(value, dirfd, pid, unscoped);
  }

  private absolute(value: AbsolutePath, dirfd: string | undefined, pid?: number, unscoped = false): AbsolutePath | undefined {
    const options = unscoped ? {} : this.options;
    if (value.startsWith("/")) return normalizeRoot(value, options);
    const base = this.baseDir(dirfd, pid);
    if (base === undefined) {
      this.diagnose(`relative path with no known directory: ${value}`);
      return undefined;
    }
    return normalizeRoot(joinPath(base, value), options);
  }

  /**
   * The directory a relative path is resolved against, in order of evidence: the `-y` annotation
   * strace printed for the fd (`5</dir>`, `AT_FDCWD</dir>` — the tracee's working directory at the
   * moment of the syscall), the fd map for a bare descriptor whose `open` was recorded, and finally
   * the observed cwd for AT_FDCWD only. Unknown numeric descriptors never imply cwd.
   * The annotation is returned untested so the caller root-filters the
   * joined path: a directory outside the observe roots then drops the record as out of scope instead
   * of silently resolving it against `cwd`.
   */
  private baseDir(dirfd: string | undefined, pid: number | undefined): AbsolutePath | undefined {
    if (dirfd === undefined || dirfd === "AT_FDCWD") return this.processState(pid).cwd.path;
    const annotated = fdAnnotation(dirfd);
    if (annotated !== undefined && annotated.length > 0) {
      if (dirfd.startsWith("AT_FDCWD")) this.setCwd(pid, annotated);
      return annotated;
    }
    const fd = fdNumber(dirfd);
    if (fd !== undefined) {
      return this.fdMap(pid).get(fd)?.path;
    }
    return undefined;
  }
}

// --- line parsing helpers -----------------------------------------------------------------------

type Prefix = { at: number; pid?: number; rest: string };

/** Strips the `[pid N]` or `pid timestamp` prefix strace writes with `-f`/`-ttt`. */
function stripPrefix(line: string): Prefix {
  const bracket = /^\[pid\s+(\d+)\]\s*(.*)$/.exec(line);
  if (bracket) return { at: 0, pid: Number(bracket[1]), rest: bracket[2] ?? "" };

  const tokens = line.split(/\s+/);
  const first = tokens[0] ?? "";
  const second = tokens[1] ?? "";
  if (/^\d+$/.test(first) && /^\d+\.\d+$/.test(second)) {
    return { at: Number(second) * 1000, pid: Number(first), rest: tokens.slice(2).join(" ") };
  }
  if (/^\d+\.\d+$/.test(first)) {
    return { at: Number(first) * 1000, rest: tokens.slice(1).join(" ") };
  }
  return { at: 0, rest: line };
}

type Call = { syscall: string; args: string; ret: string; unfinished: boolean };

/** Splits `syscall(args) = ret`, tolerating `)` inside quoted strings and `<unfinished ...>`. */
function splitCall(rest: string): Call | undefined {
  const open = rest.indexOf("(");
  if (open <= 0) return undefined;
  const syscall = rest.slice(0, open).trim();
  if (!/^[A-Za-z_]\w*$/.test(syscall)) return undefined;

  const body = scanArgs(rest, open + 1);
  if (body.unfinished) return { syscall, args: body.args, ret: "", unfinished: true };
  if (body.endIndex < 0) return undefined;

  const tail = rest.slice(body.endIndex);
  const eq = tail.indexOf("=");
  const ret = eq >= 0 ? tail.slice(eq + 1).trim() : "";
  return { syscall, args: body.args, ret, unfinished: false };
}

/** Scans from just after `(` to the matching `)`, honoring strace string quoting. */
function scanArgs(rest: string, start: number): { args: string; endIndex: number; unfinished: boolean } {
  let inString = false;
  let inAnnotation = false;
  let escaped = false;
  for (let i = start; i < rest.length; i += 1) {
    const ch = rest[i]!;
    if (inAnnotation) {
      if (ch === ">") inAnnotation = false;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "<" && rest.startsWith("<unfinished", i)) {
      return { args: rest.slice(start, i).replace(/,\s*$/, ""), endIndex: -1, unfinished: true };
    }
    if (ch === "<") { inAnnotation = true; continue; }
    if (ch === ")") return { args: rest.slice(start, i), endIndex: i + 1, unfinished: false };
  }
  return { args: rest.slice(start), endIndex: -1, unfinished: false };
}

/** Splits a syscall argument list on top-level commas (never inside quotes). */
export function splitArgs(body: string): string[] {
  const args: string[] = [];
  let current = "";
  let inString = false;
  let inAnnotation = false;
  let escaped = false;
  let depth = 0;
  for (const ch of body) {
    if (inAnnotation) {
      current += ch;
      if (ch === ">") inAnnotation = false;
      continue;
    }
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (inString) {
      current += ch;
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === "<") { inAnnotation = true; current += ch; continue; }
    if ("{[(".includes(ch)) depth++;
    else if ("}])".includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0 || args.length > 0) args.push(current.trim());
  return args;
}

/** Decodes one strace string literal (`"..."`), or returns non-string arguments unchanged. */
export function decodeStraceString(raw: string): string | undefined {
  const value = raw.trim();
  if (!value.startsWith('"')) return value.length > 0 ? value : undefined;
  if (!value.endsWith('"') || value.length < 2) return undefined;
  const body = value.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    i += 1;
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "\\":
        out += "\\";
        break;
      case '"':
        out += '"';
        break;
      case "0":
      case "1":
      case "2":
      case "3":
      case "4":
      case "5":
      case "6":
      case "7": {
        const oct = body.slice(i, i + 3);
        out += String.fromCharCode(parseInt(oct, 8) || 0);
        i += 2;
        break;
      }
      case "x": {
        const hex = body.slice(i + 1, i + 3);
        out += String.fromCharCode(parseInt(hex, 16) || 0);
        i += 2;
        break;
      }
      default:
        out += next;
        break;
    }
  }
  return out;
}

/** Recombines an `<unfinished ...>` argument prefix with its `<... name resumed>` tail. */
function resumeArgs(prefix: string, tail: string): { args: string; ret: string } {
  const close = tail.lastIndexOf(")");
  if (close < 0) return { args: `${prefix}${tail}`, ret: "" };
  const args = `${prefix}${tail.slice(0, close)}`;
  const ret = tail
    .slice(close + 1)
    .replace(/^[^=]*=\s*/, "")
    .trim();
  return { args, ret };
}

/** Reads an fd number out of `3`, `3</path>`, or a return value like `3</path>`. */
function fdNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const match = /^(\d+)/.exec(raw.trim());
  return match ? Number(match[1]) : undefined;
}

/** The path strace's `-y` annotation attached to a dirfd or `AT_FDCWD` (`5</dir>`, `AT_FDCWD</dir>`). */
function fdAnnotation(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const match = /^(?:\d+|AT_FDCWD)<([^>]*)>/.exec(raw.trim());
  return match ? (match[1] ?? "") : undefined;
}

/**
 * A symlink target, kept exactly as the tracee wrote it. The kernel stores the string
 * uninterpreted — it may be relative to the link's own directory, dangle, or point outside the
 * observe roots — and uninstall later verifies the record against `readlink`, so resolving or
 * root-filtering it would corrupt or drop the entry.
 */
function decodeLinkTarget(raw: string | undefined): AbsolutePath | undefined {
  if (raw === undefined) return undefined;
  return decodeStraceString(raw);
}

function fdFromReturn(ret: string): number | undefined {
  const match = /^(\d+)/.exec(ret.trim());
  return match ? Number(match[1]) : undefined;
}

function isSharedWritableFileMap(args: string[]): boolean {
  const prot = args[2] ?? "";
  const flags = args[3] ?? "";
  const fd = args[4] ?? "";
  if (!prot.includes("PROT_WRITE")) return false;
  if (!flags.includes("MAP_SHARED")) return false;
  if (flags.includes("MAP_ANONYMOUS") || flags.includes("MAP_ANON")) return false;
  return /^\d+<[^>]*>/.test(fd);
}

/** Decode complete open_how fields; abbreviated/unreadable/future structures stay unknown. */
function openHow(raw: string | undefined): { flags: string; mode?: string; resolve: string } | undefined {
  if (!raw?.startsWith("{") || !raw.endsWith("}")) return;
  const fields = new Map<string, string>();
  for (const field of splitArgs(raw.slice(1, -1))) {
    const match = /^(flags|mode|resolve)=(.+)$/.exec(field);
    if (!match || fields.has(match[1]!)) return;
    fields.set(match[1]!, match[2]!);
  }
  const flags = fields.get("flags"), resolve = fields.get("resolve");
  return flags !== undefined && resolve !== undefined ? { flags, resolve, mode: fields.get("mode") } : undefined;
}

/** Creation bits are shared by supported Linux targets; O_PATH and unnamed tmpfiles name no new object. */
function openFlags(raw: string): { known: boolean; created: boolean; exclusive: boolean; truncated: boolean; kind: Descriptor["kind"]; closeOnExec: boolean } {
  const named: Record<string, bigint> = { O_CREAT: 0x40n, O_EXCL: 0x80n, O_TRUNC: 0x200n, O_PATH: 0x200000n, O_TMPFILE: 0x400000n, O_CLOEXEC: 0x80000n };
  const ordinary = new Set(["O_RDONLY", "O_WRONLY", "O_RDWR", "O_APPEND", "O_ASYNC", "FASYNC", "O_DIRECT", "O_DIRECTORY", "O_DSYNC", "O_LARGEFILE", "O_NOATIME", "O_NOCTTY", "O_NOFOLLOW", "O_NONBLOCK", "O_NDELAY", "O_SYNC", "O_RSYNC", "O_ACCMODE"]);
  let bits = 0n, known = raw.length > 0;
  for (const part of raw.split("|").map(value => value.trim())) {
    if (Object.hasOwn(named, part)) bits |= named[part]!;
    else if (/^(?:0x[0-9a-f]+|0[0-7]+|[1-9][0-9]*|0)$/i.test(part)) {
      const numeric = BigInt(/^0[0-7]+$/.test(part) ? `0o${part.slice(1)}` : part);
      if ((numeric & ~0x7fffffn) !== 0n) known = false;
      bits |= numeric;
    } else if (!ordinary.has(part)) known = false;
  }
  const naming = known && (bits & (0x200000n | 0x400000n)) === 0n;
  return { known, kind: (bits & 0x400000n) !== 0n ? "unnamed" : (bits & 0x200000n) !== 0n ? "path-only" : "named",
    closeOnExec: (bits & 0x80000n) !== 0n, created: naming && (bits & 0x40n) !== 0n, exclusive: naming && (bits & 0x80n) !== 0n,
    truncated: naming && (bits & 0x200n) !== 0n };
}

function cloneSharing(raw: string): { files: boolean; fs: boolean } | undefined {
  const supported = new Set(["CLONE_VM", "CLONE_FS", "CLONE_FILES", "CLONE_SIGHAND", "CLONE_PIDFD", "CLONE_PTRACE", "CLONE_VFORK", "CLONE_PARENT", "CLONE_THREAD", "CLONE_NEWNS", "CLONE_SYSVSEM", "CLONE_SETTLS", "CLONE_PARENT_SETTID", "CLONE_CHILD_CLEARTID", "CLONE_DETACHED", "CLONE_UNTRACED", "CLONE_CHILD_SETTID", "CLONE_NEWCGROUP", "CLONE_NEWUTS", "CLONE_NEWIPC", "CLONE_NEWUSER", "CLONE_NEWPID", "CLONE_NEWNET", "CLONE_IO", "CLONE_CLEAR_SIGHAND", "CLONE_INTO_CGROUP", "CLONE_NEWTIME", "SIGCHLD"]);
  let files = false, fs = false;
  for (const flag of raw.split("|").map(value => value.trim())) {
    if (/^(?:0x[0-9a-f]+|0[0-7]+|[1-9][0-9]*|0)$/i.test(flag)) {
      const bits = BigInt(/^0[0-7]+$/.test(flag) ? `0o${flag.slice(1)}` : flag);
      if (bits > 0x3ffffffffn) return;
      files ||= (bits & 0x400n) !== 0n; fs ||= (bits & 0x200n) !== 0n;
    } else {
      if (!supported.has(flag)) return;
      files ||= flag === "CLONE_FILES"; fs ||= flag === "CLONE_FS";
    }
  }
  return { files, fs };
}

function parseMode(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!/^0[0-7]{1,4}$/.test(value)) return undefined;
  return parseInt(value, 8);
}

function pidKey(pid: number | undefined): string {
  return pid === undefined ? "?" : String(pid);
}

/**
 * Applies the observe-root filter to a traced path and keeps the path as traced. The filter decides
 * on the lexically normalized form (`..` at the root stays at the root); the traced spelling is
 * preserved because `reconstruct.ts` resolves symlinked components against the real filesystem
 * before the path is recorded, and that resolution needs the original segments.
 */
function normalizeRoot(path: string, options: ParseStraceOptions): AbsolutePath | undefined {
  const normalized = normalizeAbsolutePath(path);
  if (normalized === undefined) return undefined;
  const roots = options.roots;
  if (roots === undefined || roots.length === 0) return path;
  return inRoots(normalized, roots) ? path : undefined;
}

function joinPath(base: string, relative: string): AbsolutePath {
  const left = base.endsWith("/") ? base.slice(0, -1) : base;
  const right = relative.startsWith("/") ? relative.slice(1) : relative;
  return `${left}/${right}`;
}

function unsupportedReason(syscall: string): string {
  if (syscall === "mmap" || syscall === "mmap2" || syscall === "msync") {
    return "memory-mapped file changes are not visible to the journal";
  }
  if (syscall === "sendfile" || syscall === "sendfile64" || syscall === "copy_file_range" || syscall === "splice") {
    return "kernel-side copy changes are not visible to the journal";
  }
  if (syscall.startsWith("chown") || syscall.startsWith("lchown") || syscall.startsWith("fchown")) {
    return "ownership changes are not represented in a v3 record";
  }
  if (syscall.includes("xattr")) return "extended-attribute changes are not represented in a v3 record";
  if (syscall.startsWith("mknod") || syscall.startsWith("mkfifo"))
    return "special-file creation is not represented in a v3 record";
  if (syscall.startsWith("link")) return "hard links are not represented in a v3 record";
  if (syscall.startsWith("utime")) return "timestamp changes are not represented in a v3 record";
  return "syscall is not represented in the journal";
}
