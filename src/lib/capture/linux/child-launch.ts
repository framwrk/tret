import { type ChildProcess, spawn } from "node:child_process";
import type { Duplex, Readable, Writable } from "node:stream";
import { forwardProgramStderr, forwardProgramStdout, programLease } from "../../installer";
import type { CaptureCommand } from "../backend";
import { closeSync } from "node:fs";
import { dlopen } from "bun:ffi";
import { open } from "node:fs/promises";

const LAUNCHER = `
trap ':' INT QUIT TERM HUP
printf 'ready %s\\n' "$$" >&5 || exit 125
IFS= read -r tracer <&4 || exit 125
parent=
attached=
while read -r key value; do
  case "$key" in
    PPid:) parent=$value ;;
    TracerPid:) attached=$value; break ;;
  esac
done < "/proc/$$/status"
[ "$parent" = "$tracer" ] && [ "$attached" = "$tracer" ] || exit 125
"$@" 3>&- 4<&- 5>&- 2>&6 6>&-
code=$?
printf 'done\\n' >&3
printf 'exit %s\\n' "$code" >&5
exit "$code"
`;

export class ChildLaunch {
  readonly child: ChildProcess;
  private readonly readyPid: Promise<number | undefined>;
  readonly completion: Promise<number | undefined>;
  private readonly gate: Duplex;
  private readonly status: Duplex;
  private readonly keeper?: ChildProcess;
  private readonly programStderr?: Readable;
  private released = false;

  constructor(strace: string, args: string[], command: CaptureCommand, env: NodeJS.ProcessEnv) {
    const lease = programLease();
    const channel = lease === undefined ? undefined : leaseChannel();
    try {
      if (lease !== undefined && channel) {
        this.keeper = spawn("/bin/sh", ["-c", "trap '' INT QUIT TERM HUP; IFS= read -r line"], {
          stdio: [channel[0]!, "ignore", "ignore", lease],
        });
        this.keeper.once("error", () => this.gate?.destroy());
      }
      this.child = spawn(
        strace,
        [...args, "--", "/bin/sh", "-c", LAUNCHER, "tret-launcher", command.program, ...command.args],
        {
          env,
          stdio: ["inherit", "pipe", "pipe", channel?.[1] ?? "ignore", "pipe", "pipe", process.stderr.isTTY ? 2 : "pipe"],
        },
      );
    } finally {
      for (const fd of channel ?? []) closeSync(fd);
    }

    const streams: readonly (Readable | Writable | null | undefined)[] = this.child.stdio;
    this.gate = streams[4] as Duplex;
    this.status = streams[5] as Duplex;
    this.programStderr = streams[6] as Readable | undefined;
    this.gate.on("error", () => this.gate.destroy());
    this.status.on("error", () => this.status.destroy());
    this.child.stdout?.on("data", forwardProgramStdout);
    this.programStderr?.on("data", forwardProgramStderr);

    const ready = Promise.withResolvers<number | undefined>();
    const finished = Promise.withResolvers<number | undefined>();
    this.readyPid = ready.promise;
    this.completion = finished.promise;
    let buffer = "";
    let pid: number | undefined;
    this.status.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("ascii");
      if (buffer.length > 128) {
        this.cancel();
        this.status.destroy();
        return;
      }
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const readyMatch = /^ready ([1-9]\d{0,9})$/.exec(line);
        const exitMatch = /^exit (\d{1,3})$/.exec(line);
        if (!this.released && pid === undefined && readyMatch) {
          pid = Number(readyMatch[1]);
          ready.resolve(pid);
        } else if (this.released && exitMatch && Number(exitMatch[1]) <= 255) {
          finished.resolve(Number(exitMatch[1]));
        } else {
          this.cancel();
          this.status.destroy();
          return;
        }
      }
    });
    this.status.once("close", () => {
      ready.resolve(undefined);
      finished.resolve(undefined);
    });
  }

  async attached(pid: number): Promise<boolean> {
    const contents = await procStatus(pid);
    return (
      !this.gate.destroyed &&
      !this.status.destroyed &&
      this.child.pid !== undefined &&
      this.child.exitCode === null &&
      this.child.signalCode === null &&
      (!this.keeper || (this.keeper.exitCode === null && this.keeper.signalCode === null)) &&
      Number(/^TracerPid:\s*(\d+)/m.exec(contents)?.[1]) === this.child.pid &&
      Number(/^PPid:\s*(\d+)/m.exec(contents)?.[1]) === this.child.pid
    );
  }

  async run(): Promise<number | undefined> {
    if (this.released || this.gate.destroyed || this.status.destroyed || this.child.pid === undefined) return;
    this.released = true;
    this.gate.end(`${this.child.pid}\n`);
    return this.completion;
  }

  async waitForReady(timeoutMs: number): Promise<number | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.readyPid,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  cancel(): void {
    this.gate.destroy();
  }

  close(): void {
    this.cancel();
    this.status.destroy();
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    this.programStderr?.destroy();
  }
}

async function procStatus(pid: number): Promise<string> {
  let file;
  try {
    file = await open(`/proc/${pid}/status`, "r");
    const bytes = Buffer.alloc(4096);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead).toString();
  } catch {
    return "";
  } finally {
    await file?.close();
  }
}

export function capTracerAudit(pid: number, bytes: number): void {
  const libc = dlopen("libc.so.6", { prlimit: { args: ["i32", "i32", "ptr", "ptr"], returns: "i32" } });
  try {
    const limits = new BigUint64Array(2);
    const fileSize = 1;
    if (libc.symbols.prlimit(pid, fileSize, null, limits) !== 0) throw new Error("cannot read strace file size limit");
    if (BigInt(bytes) < limits[0]!) {
      limits[0] = BigInt(bytes);
      if (libc.symbols.prlimit(pid, fileSize, limits, null) !== 0) throw new Error("cannot bound strace audit file");
    }
  } finally {
    libc.close();
  }
}

function leaseChannel(): Int32Array {
  const libc = dlopen("libc.so.6", { socketpair: { args: ["i32", "i32", "i32", "ptr"], returns: "i32" } });
  try {
    const fds = new Int32Array(2);
    const unix = 1;
    const streamCloseOnExec = 1 | 0x80000;
    if (libc.symbols.socketpair(unix, streamCloseOnExec, 0, fds) !== 0)
      throw new Error("cannot open the launcher lease channel");
    return fds;
  } finally {
    libc.close();
  }
}
