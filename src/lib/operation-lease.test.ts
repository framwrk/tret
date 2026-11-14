import { OperationLockedError, currentOperationToken, withOperationLease } from "./operation-lease";
import { afterEach, expect, test } from "bun:test";
import { linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tret-operation-lease-"));
  roots.push(root);
  return root;
}

test("internal calls reuse a lease while an independent async operation must contend", async () => {
  const root = fixture();
  let release!: () => void;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => (ready = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const first = withOperationLease(root, async (token) => {
    expect(currentOperationToken(root)).toBe(token);
    await withOperationLease(root, async (nested) => expect(nested).toBe(token), 0);
    ready();
    await gate;
  });
  await started;
  try {
    await expect(withOperationLease(root, async () => {}, 40)).rejects.toBeInstanceOf(OperationLockedError);
    expect(currentOperationToken(root)).toBeUndefined();
    await withOperationLease(join(root, "another-store"), async () => {});
  } finally {
    release();
    await first;
  }
  await withOperationLease(root, async () => {});
  expect(lstatSync(join(root, "operation.lock")).mode & 0o777).toBe(0o600);
});

test("SIGKILL releases the kernel lock without removing or replacing its stable file", async () => {
  const root = fixture();
  const modulePath = new URL("./operation-lease.ts", import.meta.url).pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
      import { withOperationLease } from ${JSON.stringify(modulePath)};
      await withOperationLease(${JSON.stringify(root)}, async () => {
        console.log("held");
        await Bun.stdin.text();
      });
    `,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("held");
    reader.releaseLock();
    const original = lstatSync(join(root, "operation.lock"), { bigint: true });
    await expect(withOperationLease(root, async () => {}, 0)).rejects.toBeInstanceOf(OperationLockedError);
    child.kill("SIGKILL");
    await child.exited;
    await withOperationLease(root, async () => {});
    expect(lstatSync(join(root, "operation.lock"), { bigint: true }).ino).toBe(original.ino);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
});

test("operation locks reject symlink and hard-link aliases without changing their targets", async () => {
  const root = fixture();
  const target = join(root, "unrelated");
  writeFileSync(target, "keep", { mode: 0o644 });
  const path = join(root, "operation.lock");
  symlinkSync(target, path);
  await expect(withOperationLease(root, async () => {})).rejects.toThrow();
  rmSync(path);
  linkSync(target, path);
  await expect(withOperationLease(root, async () => {})).rejects.toThrow("without aliases");
  expect(readFileSync(target, "utf8")).toBe("keep");
  expect(lstatSync(target).mode & 0o777).toBe(0o644);
});

test("a callback failure releases the lease and keeps the same file for a retry", async () => {
  const root = fixture();
  await expect(
    withOperationLease(root, async () => {
      throw new Error("failed work");
    }),
  ).rejects.toThrow("failed work");
  const ino = lstatSync(join(root, "operation.lock"), { bigint: true }).ino;
  await withOperationLease(root, async () => {});
  expect(lstatSync(join(root, "operation.lock"), { bigint: true }).ino).toBe(ino);
});

test("a supervised foreground program retains the lease after its Tret parent is killed", async () => {
  const home = fixture();
  const state = join(home, ".tret");
  const marker = join(home, "running");
  const gate = join(home, "release");
  const script = join(home, "foreground.sh");
  writeFileSync(script, `#!/bin/sh\nprintf ready > '${marker}'\nwhile [ ! -f '${gate}' ]; do /bin/sleep 0.05; done\n`, {
    mode: 0o755,
  });
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { withOperationLease } from ${JSON.stringify(new URL("./operation-lease.ts", import.meta.url).pathname)};
    import { runProgram } from ${JSON.stringify(new URL("./installer.ts", import.meta.url).pathname)};
    await withOperationLease(${JSON.stringify(state)}, () => runProgram(${JSON.stringify(script)}));
  `,
    ],
    { env: { ...process.env, HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  try {
    const deadline = performance.now() + 10_000;
    while (!(await Bun.file(marker).exists())) {
      if (performance.now() > deadline) throw new Error("foreground fixture did not start");
      await Bun.sleep(10);
    }
    child.kill("SIGKILL");
    await child.exited;
    await expect(withOperationLease(state, async () => {}, 0)).rejects.toBeInstanceOf(OperationLockedError);
    writeFileSync(gate, "release");
    await withOperationLease(state, async () => {});
  } finally {
    writeFileSync(gate, "release");
    child.kill("SIGKILL");
    await child.exited;
    await withOperationLease(state, async () => {});
  }
});

test("the foreground supervisor preserves the program's SIGINT handling", async () => {
  const home = fixture();
  const state = join(home, ".tret");
  const pidPath = join(home, "program.pid");
  const stopped = join(home, "stopped");
  const gate = join(home, "release");
  const script = join(home, "signal.sh");
  writeFileSync(
    script,
    `#!/bin/sh\ntrap 'printf stopped > "${stopped}"; exit 0' INT\nprintf '%s' "$$" > '${pidPath}'\nwhile [ ! -f '${gate}' ]; do /bin/sleep 0.05; done\n`,
    { mode: 0o755 },
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { withOperationLease } from ${JSON.stringify(new URL("./operation-lease.ts", import.meta.url).pathname)};
    import { runProgram } from ${JSON.stringify(new URL("./installer.ts", import.meta.url).pathname)};
    await withOperationLease(${JSON.stringify(state)}, () => runProgram(${JSON.stringify(script)}));
  `,
    ],
    { env: { ...process.env, HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  try {
    const deadline = performance.now() + 10_000;
    while (!(await Bun.file(pidPath).exists())) {
      if (performance.now() > deadline) throw new Error("signal fixture did not start");
      await Bun.sleep(10);
    }
    const pid = Number(readFileSync(pidPath, "utf8"));
    expect(Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid).toBe(true);
    process.kill(pid, "SIGINT");
    while (!(await Bun.file(stopped).exists())) {
      if (performance.now() > deadline) throw new Error("program inherited an ignored SIGINT");
      await Bun.sleep(10);
    }
    expect(await child.exited).toBe(0);
  } finally {
    writeFileSync(gate, "release");
    child.kill("SIGKILL");
    await child.exited;
    await withOperationLease(state, async () => {});
  }
});
