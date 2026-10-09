import type { TracerRecord, TracerResult } from "./raw";
import type { AbsolutePath } from "../../../types";

/**
 * Pure parser for `strace` output (`-f -ttt -y -o <file>`, one line per syscall). It turns syscall
 * lines into `TracerRecord`s; `reconstruct.ts` then inspects the filesystem for before/after
 * metadata. Parsing is separated from spawning so the exact same code is exercised on hosts without
 * a Linux ptrace tracer (plan section 8, phase 4 conformance tests).
 *
 * Coverage caveats the parser reports instead of hiding:
 * - Paths relative to `AT_FDCWD` are resolved against the supplied `cwd` because strace does not
 *   report a tracee's working directory; a relative path with no known directory is dropped with a
 *   diagnostic.
 * - Unknown fds in `write`-family calls become a diagnostic (the fd map is reset when strace cannot
 *   report an `open` we parsed, for example a write inherited across a `fork` we did not trace).
 * - Syscalls that can change content or metadata in a way the journal cannot represent (`mmap`
 *   `PROT_WRITE`, `sendfile`, `copy_file_range`, `fallocate`, xattr, chown, hard links) are reported
 *   as `unsupported` so completeness is lowered rather than overstated.
 */

/** Options that affect relative-path resolution and which syscalls are considered in scope. */
export type ParseStraceOptions = {
  /** Directory used to resolve `AT_FDCWD`-relative paths; defaults to `/`. */
  cwd?: AbsolutePath;
  /**
   * Only records whose path falls under one of these roots are kept. Empty or omitted means "keep
   * everything", which the backend uses when it wants to attribute the whole traced tree.
   */
  roots?: AbsolutePath[];
};

export function parseStraceOutput(text: string, options: ParseStraceOptions = {}): TracerResult {
  const parser = new StraceParser(options);
  for (const line of text.split("\n")) parser.feed(line);
  parser.finish();
  return parser.result();
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

type Pending = { at: number; pid?: number; syscall: string; args: string };

class StraceParser {
  private readonly options: ParseStraceOptions;
  private readonly records: TracerRecord[] = [];
  private readonly unsupported = new Set<string>();
  private readonly diagnostics: string[] = [];
  private readonly pending = new Map<string, Pending>();
  /** Open file descriptors per pid, so a `write` can be tied back to a path. */
  private readonly fds = new Map<string, Map<number, AbsolutePath>>();
  private readonly seenUnsupported = new Set<string>();

  constructor(options: ParseStraceOptions) {
    this.options = options;
  }

  feed(rawLine: string): void {
    const line = rawLine.replace(/\r$/, "").trimEnd();
    if (line.length === 0) return;

    const prefix = stripPrefix(line);
    if (prefix.rest.length === 0) return;

    const resumed = /^<\.\.\.\s+(\w+)\s+resumed>(.*)$/.exec(prefix.rest);
    if (resumed) {
      const key = pidKey(prefix.pid);
      const pending = this.pending.get(key);
      const syscall = resumed[1] ?? "";
      const tail = resumed[2] ?? "";
      if (!pending || pending.syscall !== syscall) {
        this.diagnostics.push(`resumed syscall without a matching unfinished line: ${syscall}`);
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
      this.diagnostics.push(`unfinished syscall was never resumed: ${pending.syscall}`);
    }
    this.pending.clear();
  }

  result(): TracerResult {
    return {
      records: this.records.slice(),
      unsupported: [...this.unsupported].sort(),
      diagnostics: this.diagnostics.slice(),
    };
  }

  private handleCall(at: number, pid: number | undefined, syscall: string, argsBody: string, ret: string): void {
    const args = splitArgs(argsBody);
    const failed = ret.startsWith("-1") || ret.startsWith("-");

    // `mmap` is only a journal gap when it is a shared, writable, file-backed mapping; ordinary
    // anonymous allocations would otherwise mark almost every process as incomplete.
    if (syscall === "mmap" || syscall === "mmap2") {
      if (!failed && isSharedWritableFileMap(args)) {
        this.markUnsupported(syscall, undefined);
        this.records.push({ op: "unsupported", at, pid, syscall, reason: unsupportedReason(syscall) });
      }
      return;
    }

    if (UNSUPPORTED_SYSCALLS.has(syscall)) {
      // A successful unsupported syscall may have changed content the journal cannot see.
      if (!failed) {
        this.markUnsupported(syscall, undefined);
        this.records.push({ op: "unsupported", at, pid, syscall, reason: unsupportedReason(syscall) });
      }
      return;
    }

    switch (syscall) {
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
        if (!failed) this.emitWrite(at, pid, this.resolvePath(args[0]));
        return;
      case "ftruncate":
        if (!failed) this.emitWrite(at, pid, this.resolveFd(pid, args[0]));
        return;
      case "rename":
        if (!failed) this.emitRename(at, pid, this.resolvePath(args[0]), this.resolvePath(args[1]));
        return;
      case "renameat":
        if (!failed)
          this.emitRename(at, pid, this.resolvePathAt(args[0], args[1], pid), this.resolvePathAt(args[2], args[3], pid));
        return;
      case "renameat2":
        if (!failed)
          this.emitRename(at, pid, this.resolvePathAt(args[0], args[1], pid), this.resolvePathAt(args[2], args[3], pid));
        return;
      case "unlink":
        if (!failed) this.emitUnlink(at, pid, this.resolvePath(args[0]));
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
        if (!failed) this.emitChmod(at, pid, this.resolvePath(args[0]), args[1]);
        return;
      case "fchmod":
        if (!failed) this.emitChmod(at, pid, this.resolveFd(pid, args[0]), args[1]);
        return;
      case "fchmodat":
      case "fchmodat2":
        if (!failed) this.emitChmod(at, pid, this.resolvePathAt(args[0], args[1], pid), args[2]);
        return;
      case "symlink":
        if (!failed) this.emitSymlink(at, pid, this.resolvePath(args[1]), this.resolvePath(args[0]));
        return;
      case "symlinkat":
        if (!failed) this.emitSymlink(at, pid, this.resolvePathAt(args[1], args[2], pid), this.resolvePath(args[0]));
        return;
      case "mkdir":
        if (!failed) this.emitMkdir(at, pid, this.resolvePath(args[0]), args[1]);
        return;
      case "mkdirat":
        if (!failed) this.emitMkdir(at, pid, this.resolvePathAt(args[0], args[1], pid), args[2]);
        return;
      case "rmdir":
        if (!failed) this.emitRmdir(at, pid, this.resolvePath(args[0]));
        return;
      case "close": {
        const pidMap = this.fds.get(pidKey(pid));
        const fd = fdNumber(args[0]);
        if (pidMap && fd !== undefined) pidMap.delete(fd);
        return;
      }
      case "dup":
      case "dup2":
      case "dup3": {
        const from = fdNumber(args[0]);
        const to = syscall === "dup" ? fdNumber(ret) : fdNumber(args[1]);
        const path = from !== undefined ? this.resolveFd(pid, args[0]) : undefined;
        if (path !== undefined && to !== undefined) this.fdMap(pid).set(to, path);
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
      path = this.resolvePath(args[0]);
      flags = "O_CREAT|O_WRONLY|O_TRUNC";
    } else if (syscall === "open") {
      path = this.resolvePath(args[0]);
      flags = args[1] ?? "";
    } else {
      path = this.resolvePathAt(args[0], args[1], pid);
      flags = args[2] ?? "";
    }
    if (path === undefined) return;

    const fd = fdFromReturn(ret);
    if (fd !== undefined) this.fdMap(pid).set(fd, path);

    // `openat2` puts flags in a struct we do not decode; treat it as an open with unknown flags.
    if (syscall === "openat2") flags = "";
    this.records.push({
      op: "open",
      at,
      pid,
      path,
      created: flags.includes("O_CREAT") || syscall === "creat",
      truncated: flags.includes("O_TRUNC"),
      mode: parseMode(args[args.length - 1]),
    });
  }

  private handleWrite(at: number, pid: number | undefined, args: string[]): void {
    const path = this.resolveFd(pid, args[0]);
    this.emitWrite(at, pid, path);
  }

  private emitWrite(at: number, pid: number | undefined, path: AbsolutePath | undefined): void {
    if (path === undefined) return;
    this.records.push({ op: "write", at, pid, path });
  }

  private emitRename(at: number, pid: number | undefined, from: AbsolutePath | undefined, to: AbsolutePath | undefined): void {
    if (from === undefined || to === undefined) return;
    this.records.push({ op: "rename", at, pid, from, to });
  }

  private emitUnlink(at: number, pid: number | undefined, path: AbsolutePath | undefined): void {
    if (path === undefined) return;
    this.records.push({ op: "unlink", at, pid, path });
  }

  private emitRmdir(at: number, pid: number | undefined, path: AbsolutePath | undefined): void {
    if (path === undefined) return;
    this.records.push({ op: "rmdir", at, pid, path });
  }

  private emitChmod(at: number, pid: number | undefined, path: AbsolutePath | undefined, rawMode: string | undefined): void {
    if (path === undefined) return;
    const mode = parseMode(rawMode);
    if (mode === undefined) return;
    this.records.push({ op: "chmod", at, pid, path, mode });
  }

  private emitSymlink(
    at: number,
    pid: number | undefined,
    path: AbsolutePath | undefined,
    target: AbsolutePath | undefined,
  ): void {
    if (path === undefined || target === undefined) return;
    this.records.push({ op: "symlink", at, pid, path, target });
  }

  private emitMkdir(at: number, pid: number | undefined, path: AbsolutePath | undefined, rawMode: string | undefined): void {
    if (path === undefined) return;
    this.records.push({ op: "mkdir", at, pid, path, mode: parseMode(rawMode) });
  }

  private markUnsupported(syscall: string, path: AbsolutePath | undefined): void {
    const key = path === undefined ? syscall : `${syscall}:${path}`;
    if (this.seenUnsupported.has(key)) return;
    this.seenUnsupported.add(key);
    this.unsupported.add(syscall);
  }

  private fdMap(pid: number | undefined): Map<number, AbsolutePath> {
    const key = pidKey(pid);
    let map = this.fds.get(key);
    if (!map) {
      map = new Map();
      this.fds.set(key, map);
    }
    return map;
  }

  /** Resolves an fd argument, preferring the `-y` path annotation and falling back to the fd map. */
  private resolveFd(pid: number | undefined, raw: string | undefined): AbsolutePath | undefined {
    if (raw === undefined) return undefined;
    const annotated = /^(\d+)<([^>]*)>/.exec(raw);
    if (annotated) return normalizeRoot(annotated[2] ?? "", this.options);
    const fd = fdNumber(raw);
    if (fd === undefined) return undefined;
    return this.fds.get(pidKey(pid))?.get(fd);
  }

  private resolvePath(raw: string | undefined): AbsolutePath | undefined {
    if (raw === undefined) return undefined;
    const value = decodeStraceString(raw);
    if (value === undefined) return undefined;
    return this.absolute(value, undefined);
  }

  /** Resolves `(dirfd, path)` pairs, honoring an annotated dirfd and `AT_FDCWD`. */
  private resolvePathAt(dirfd: string | undefined, raw: string | undefined, pid: number | undefined): AbsolutePath | undefined {
    if (raw === undefined) return undefined;
    const value = decodeStraceString(raw);
    if (value === undefined) return undefined;
    return this.absolute(value, dirfd, pid);
  }

  private absolute(value: AbsolutePath, dirfd: string | undefined, pid?: number): AbsolutePath | undefined {
    if (value.startsWith("/")) return normalizeRoot(value, this.options);
    let base = this.options.cwd;
    if (dirfd !== undefined && dirfd !== "AT_FDCWD") {
      const dir = this.resolveFd(pid, dirfd);
      if (dir !== undefined) base = dir;
    }
    if (base === undefined) {
      this.diagnostics.push(`relative path with no known directory: ${value}`);
      return undefined;
    }
    return normalizeRoot(joinPath(base, value), this.options);
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
  let escaped = false;
  for (let i = start; i < rest.length; i += 1) {
    const ch = rest[i]!;
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
    if (ch === ")") return { args: rest.slice(start, i), endIndex: i + 1, unfinished: false };
    if (ch === "<" && rest.startsWith("<unfinished", i)) {
      return { args: rest.slice(start, i).replace(/,\s*$/, ""), endIndex: -1, unfinished: true };
    }
  }
  return { args: rest.slice(start), endIndex: -1, unfinished: false };
}

/** Splits a syscall argument list on top-level commas (never inside quotes). */
export function splitArgs(body: string): string[] {
  const args: string[] = [];
  let current = "";
  let inString = false;
  let escaped = false;
  for (const ch of body) {
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
    if (ch === ",") {
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

function parseMode(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!/^0[0-7]{1,4}$/.test(value)) return undefined;
  return parseInt(value, 8);
}

function pidKey(pid: number | undefined): string {
  return pid === undefined ? "?" : String(pid);
}

function normalizeRoot(path: string, options: ParseStraceOptions): AbsolutePath | undefined {
  const roots = options.roots;
  if (!roots || roots.length === 0) return path;
  return inRoots(path, roots) ? path : undefined;
}

/** Whether `path` is `root` itself or a descendant of it, without matching `/usr` for `/usrx`. */
export function inRoots(path: AbsolutePath, roots: AbsolutePath[]): boolean {
  return roots.some((root) => {
    if (path === root) return true;
    const prefix = root.endsWith("/") ? root : `${root}/`;
    return path.startsWith(prefix);
  });
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
