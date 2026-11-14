import { type CleanupApproval, cleanupSnapshot } from "./cleanup-authority";
import { type NativeActionReceipt, applyNativeAction } from "./native-action";
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { NativeDirectory } from "./native-filesystem";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tret-native-action-"));
  roots.push(root);
  return root;
}
function approval(path: string, action: "remove" | "restore"): CleanupApproval {
  return { action, approvedAt: new Date().toISOString(), current: cleanupSnapshot(path) };
}

test("an approved removal and a byte/mode restore use durable action cursors", async () => {
  const root = fixture();
  const path = join(root, "file");
  writeFileSync(path, "installed");
  const steps: string[] = [];
  await applyNativeAction({
    approval: approval(path, "remove"),
    checkpoint: async (receipt) => {
      steps.push(receipt.step);
    },
  });
  expect(existsSync(path)).toBe(false);
  expect(steps).toEqual(["prepared", "staged", "quarantined", "committed", "finished"]);
  writeFileSync(path, "after");
  await applyNativeAction({
    approval: approval(path, "restore"),
    bytes: new TextEncoder().encode("before"),
    mode: 0o640,
    checkpoint: async () => {},
  });
  expect(readFileSync(path, "utf8")).toBe("before");
  expect(cleanupSnapshot(path).node?.mode).toBe(0o640);
});

test("a replacement captured in the rename race is verified and rolled back without deletion", async () => {
  const root = fixture();
  const path = join(root, "file");
  writeFileSync(path, "approved");
  const selected = approval(path, "remove");
  const originalMove = NativeDirectory.prototype.moveExclusive;
  let swapped = false;
  NativeDirectory.prototype.moveExclusive = function (name, destination, target) {
    if (!swapped && name === "file" && target === "original") {
      swapped = true;
      renameSync(path, join(root, "approved-moved-aside"));
      writeFileSync(path, "unrelated sentinel");
    }
    return originalMove.call(this, name, destination, target);
  };
  try {
    await expect(applyNativeAction({ approval: selected, checkpoint: async () => {} })).rejects.toThrow(
      "differs from the approved object",
    );
    expect(readFileSync(path, "utf8")).toBe("unrelated sentinel");
    expect(readFileSync(join(root, "approved-moved-aside"), "utf8")).toBe("approved");
  } finally {
    NativeDirectory.prototype.moveExclusive = originalMove;
  }
});

test("a concurrently reoccupied restore path and the captured old file both survive", async () => {
  const root = fixture();
  const path = join(root, "file");
  writeFileSync(path, "installed");
  let last: NativeActionReceipt | undefined;
  await expect(
    applyNativeAction({
      approval: approval(path, "restore"),
      bytes: new TextEncoder().encode("before"),
      checkpoint: async (receipt) => {
        last = receipt;
        if (receipt.step === "quarantined") writeFileSync(path, "new user work");
      },
    }),
  ).rejects.toThrow("exclusive");
  expect(readFileSync(path, "utf8")).toBe("new user work");
  expect(last?.step).toBe("retained");
  expect(readFileSync(join(root, last!.stageName, "original"), "utf8")).toBe("installed");
});

test("new directory children and parent permission substitutions are preserved", async () => {
  const root = fixture();
  const path = join(root, "directory");
  mkdirSync(path);
  const selected = approval(path, "remove");
  writeFileSync(join(path, "new-user-file"), "keep");
  await expect(applyNativeAction({ approval: selected, checkpoint: async () => {} })).rejects.toThrow("removal refused");
  expect(readFileSync(join(path, "new-user-file"), "utf8")).toBe("keep");
  const file = join(root, "file");
  writeFileSync(file, "keep");
  const original = approval(file, "remove");
  chmodSync(root, 0o750);
  await expect(applyNativeAction({ approval: original, checkpoint: async () => {} })).rejects.toThrow(
    "parent directory changed",
  );
  expect(readFileSync(file, "utf8")).toBe("keep");
});

test("an ancestor swap during application preserves the new namespace and reports a partial action", async () => {
  const root = fixture();
  const parent = join(root, "parent");
  const unrelated = join(root, "unrelated");
  mkdirSync(parent);
  mkdirSync(unrelated);
  const path = join(parent, "file");
  writeFileSync(path, "approved");
  writeFileSync(join(unrelated, "file"), "keep sentinel");
  await expect(
    applyNativeAction({
      approval: approval(path, "remove"),
      checkpoint: async (receipt) => {
        if (receipt.step === "quarantined") {
          renameSync(parent, join(root, "moved-parent"));
          symlinkSync(unrelated, parent);
        }
      },
    }),
  ).rejects.toThrow("ancestor namespace changed");
  expect(readFileSync(join(unrelated, "file"), "utf8")).toBe("keep sentinel");
});

test.each([false, true])("recovery after SIGKILL verifies an already committed restore (later edit: %s)", async (edit) => {
  const root = fixture();
  const path = join(root, "file");
  writeFileSync(path, "installed");
  const selected = approval(path, "restore");
  const receiptPath = join(root, "receipt.json");
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
    import { applyNativeAction } from ${JSON.stringify(new URL("./native-action.ts", import.meta.url).pathname)};
    import { writeFileAtomic } from ${JSON.stringify(new URL("./atomic.ts", import.meta.url).pathname)};
    await applyNativeAction({
      approval: ${JSON.stringify(selected)}, bytes: new TextEncoder().encode("before"),
      checkpoint: async (receipt) => {
        if (receipt.step === "committed") process.kill(process.pid, "SIGKILL");
        writeFileAtomic(${JSON.stringify(receiptPath)}, JSON.stringify(receipt), 0o600);
      },
    });
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  await child.exited;
  expect(child.signalCode).toBe("SIGKILL");
  const cursor: NativeActionReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  expect(cursor.step).toBe("replacement-staged");
  expect(readFileSync(path, "utf8")).toBe("before");
  if (edit) writeFileSync(path, "newer user edit");
  const work = applyNativeAction({
    approval: selected,
    bytes: new TextEncoder().encode("before"),
    resume: cursor,
    checkpoint: async () => {},
  });
  if (edit) {
    await expect(work).rejects.toThrow("postcondition changed");
    expect(readFileSync(path, "utf8")).toBe("newer user edit");
    expect(readFileSync(join(root, cursor.stageName, "original"), "utf8")).toBe("installed");
  } else {
    expect((await work).step).toBe("finished");
    expect(readFileSync(path, "utf8")).toBe("before");
  }
});
