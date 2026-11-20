import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { expect, test } from "bun:test";
import { ChildLaunch } from "./child-launch";
import { LinuxCaptureBackend } from "./backend";
import { join } from "node:path";
import { once } from "node:events";
import { runBoundedSession } from "../../session";
import { tmpdir } from "node:os";

test.each(["cancel", "untraced release"] as const)("gated launcher refuses %s", async (action) => {
  const root = mkdtempSync(join(tmpdir(), "tret-child-gate-"));
  const marker = join(root, "executed");
  const payload =
    'for fd in 3 4 5 6; do (case "$fd" in 3) : >&3;; 4) : <&4;; 5) : >&5;; 6) : >&6;; esac) 2>/dev/null && exit 99; done; printf "%s\\n" "$2" >> "$1"; exit 7';
  const launch = new ChildLaunch(
    "/bin/sh",
    ["-c", 'shift; "$@"', "stand-in"],
    {
      program: "/bin/sh",
      args: ["-c", payload, "fixture", marker, "a literal argument; *"],
    },
    process.env,
  );
  const exited = once(launch.child, "exit");
  try {
    expect(await launch.waitForReady(1000)).toBeGreaterThan(0);
    expect(existsSync(marker)).toBe(false);
    if (action === "cancel") {
      launch.cancel();
      await exited;
      expect(await launch.completion).toBeUndefined();
      expect(existsSync(marker)).toBe(false);
    } else {
      expect(await launch.run()).toBeUndefined();
      expect(await launch.run()).toBeUndefined();
      expect(existsSync(marker)).toBe(false);
    }
  } finally {
    launch.close();
    launch.child.kill();
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux" || Bun.which("strace") === null)(
  "the launcher refuses release after the confirmed tracer detaches",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "tret-child-detach-"));
    const marker = join(root, "executed");
    const launch = new ChildLaunch(
      Bun.which("strace")!,
      ["-f", "-I", "2", "-o", join(root, "audit")],
      { program: "/bin/sh", args: ["-c", 'printf ran > "$1"', "fixture", marker] },
      process.env,
    );
    const exited = once(launch.child, "exit");
    try {
      const pid = await launch.waitForReady(2000);
      expect(pid).toBeDefined();
      expect(await launch.attached(pid!)).toBe(true);
      launch.child.kill("SIGKILL");
      await exited;
      expect(await launch.run()).toBeUndefined();
      expect(existsSync(marker)).toBe(false);
    } finally {
      launch.close();
      launch.child.kill();
      await exited;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("a live subprocess without a readiness message cannot release a program", async () => {
  const launch = new ChildLaunch(
    "/bin/sh",
    ["-c", "read -r _ <&4", "stand-in"],
    {
      program: "/bin/false",
      args: [],
    },
    process.env,
  );
  const exited = once(launch.child, "exit");
  try {
    expect(await launch.waitForReady(30)).toBeUndefined();
    launch.cancel();
    await exited;
    expect(await launch.completion).toBeUndefined();
  } finally {
    launch.close();
    launch.child.kill();
    await exited;
  }
});

test.skipIf(process.platform !== "linux" || Bun.which("strace") === null)(
  "the real child tracer never releases a command when durable preparation fails",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "tret-child-barrier-"));
    const marker = join(root, "executed");
    let checkedBarrier = false;
    try {
      await expect(
        runBoundedSession({
          backend: new LinuxCaptureBackend({ baseline: "none" }),
          pid: process.pid,
          roots: [root],
          privilege: "user",
          command: { program: "/bin/sh", args: ["-c", 'printf ran > "$1"', "fixture", marker] },
          beforeRun: async () => {
            checkedBarrier = true;
            expect(existsSync(marker)).toBe(false);
            throw new Error("injected persistence failure");
          },
          run: (session) => session.runProgram!(),
        }),
      ).rejects.toThrow("injected persistence failure");
      expect(checkedBarrier).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
