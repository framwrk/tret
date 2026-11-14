import { NativeDirectory, type NodeIdentity, descriptorIdentity, nativeParent } from "./native-filesystem";
import { filesystemIdentity, sameFilesystemIdentity } from "./filesystem-identity";
import { protectedCleanupPath, validCleanupApproval } from "./cleanup-authority";
import type { CleanupApproval } from "./cleanup-authority";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type NativeActionReceipt = {
  version: 1;
  path: string;
  stageName: string;
  step: "prepared" | "staged" | "quarantined" | "replacement-staged" | "committed" | "finished" | "retained";
  directory?: NodeIdentity;
  replacement?: NodeIdentity;
  reason?: string;
};

type NativeActionOptions = {
  approval: CleanupApproval;
  bytes?: Uint8Array;
  mode?: number;
  /** Must persist before returning. A failure stops before the following namespace change. */
  checkpoint: (receipt: NativeActionReceipt) => Promise<void>;
  resume?: NativeActionReceipt;
};

/** Object identity is stable across our own rename; directory contents may change as siblings finish. */
function matchesCaptured(actual: NodeIdentity | undefined, expected: NodeIdentity | null): boolean {
  if (!actual || !expected) return !actual && !expected;
  const keys =
    expected.kind === "directory"
      ? (["dev", "ino", "kind", "mode", "uid", "gid"] as const)
      : (["dev", "ino", "kind", "mode", "uid", "gid", "links", "size", "mtime"] as const);
  return keys.every((key) => actual[key] === expected[key]);
}

function verifyCaptured(directory: NativeDirectory, name: string, approval: CleanupApproval, initial = false): void {
  const expected = approval.current;
  const actual = directory.inspect(name);
  if (!matchesCaptured(actual, expected.node)) throw new Error("captured object differs from the approved object");
  if (initial && actual?.kind !== "directory" && actual?.ctime !== expected.node?.ctime)
    throw new Error("approved object metadata changed");
  if (actual?.kind === "file" && directory.hash(name, actual) !== expected.hash)
    throw new Error("captured file content changed");
  if (actual?.kind === "symlink" && directory.linkTarget(name) !== expected.linkTarget)
    throw new Error("captured link target changed");
}

/**
 * Capture first, verify privately, then remove. Neither rollback nor restoration can overwrite an
 * occupied name. A crash retains the source object/staged replacement and a durable state cursor.
 * Recovery verifies objects and postconditions; it never blindly repeats a completed restore.
 */
export async function applyNativeAction(options: NativeActionOptions): Promise<NativeActionReceipt> {
  const { approval, checkpoint } = options;
  const expected = approval.current;
  if (!validCleanupApproval(approval, expected?.path)) throw new Error("native action approval is malformed");
  if (options.resume && !validNativeReceipt(options.resume))
    throw new Error("native recovery cursor is unsupported or malformed");
  const protectedReason = protectedCleanupPath(expected.path);
  if (protectedReason) throw new Error(`cleanup refused: ${protectedReason}`);
  if (approval.action === "restore" && options.bytes === undefined) throw new Error("verified restore content is required");
  if (approval.action === "restore" && expected.node && expected.node.kind !== "file")
    throw new Error("this restoration node type is unsupported");
  const { directory: parent, name } = nativeParent(expected.path);
  let stage: NativeDirectory | undefined;
  let receipt: NativeActionReceipt = options.resume ?? {
    version: 1,
    path: expected.path,
    stageName: `.tret-stage-${randomUUID()}`,
    step: "prepared",
  };
  const persist = async (change: Partial<NativeActionReceipt>) => {
    const next = { ...receipt, ...change };
    await checkpoint(next);
    receipt = next;
  };
  try {
    if (receipt.path !== expected.path || !/^\.tret-stage-[0-9a-f-]{36}$/.test(receipt.stageName))
      throw new Error("invalid native recovery cursor");
    if (!(["dev", "ino", "kind", "mode", "uid", "gid"] as const).every((key) => parent.identity[key] === expected.parent[key]))
      throw new Error("approved parent directory changed");
    const ancestors = { ...expected.ancestors };
    delete ancestors[expected.path];
    if (!sameFilesystemIdentity(ancestors, filesystemIdentity(dirname(expected.path))))
      throw new Error("approved ancestor chain changed");

    if (receipt.step === "finished") {
      verifyPostcondition();
      return receipt;
    }
    if (receipt.step === "retained") throw new Error("retained objects require manual reconciliation");
    if (!options.resume) {
      // No namespace change precedes the initial durable cursor.
      verifyCaptured(parent, name, approval, true);
      await persist({});
      stage = parent.createDirectory(receipt.stageName);
      parent.sync();
      await persist({ step: "staged", directory: stage.identity });
    } else {
      if (!receipt.directory) throw new Error("staging identity was not durably captured; reconcile manually");
      stage = new NativeDirectory("", { directory: parent, name: receipt.stageName });
      if (stage.identity.dev !== receipt.directory.dev || stage.identity.ino !== receipt.directory.ino)
        throw new Error("recovery staging directory changed");
    }

    if (receipt.step === "staged") {
      if (expected.node && !stage.inspect("original")) {
        verifyCaptured(parent, name, approval, true);
        parent.moveExclusive(name, stage, "original");
        parent.sync();
        stage.sync();
      } else if (!expected.node && parent.inspect(name)) throw new Error("restore destination was reoccupied");
      if (expected.node) verifyCaptured(stage, "original", approval);
      await persist({ step: "quarantined" });
    }

    if (approval.action === "remove") {
      if (receipt.step !== "quarantined" && receipt.step !== "committed") throw new Error("unexpected removal recovery stage");
      const original = stage.inspect("original");
      if (original) {
        verifyCaptured(stage, "original", approval);
        if (original.kind === "unsupported") throw new Error("special node removal is unsupported");
        stage.unlink("original", original.kind);
        stage.sync();
      }
      await persist({ step: "committed" });
    } else {
      if (receipt.step === "quarantined") {
        // An uncheckpointed replacement might contain only a short write. Never adopt it.
        if (stage.inspect("replacement")) throw new Error("replacement write has no durable identity; reconcile manually");
        const replacement = stage.writeExclusive("replacement", options.bytes!, options.mode ?? 0o600);
        stage.sync();
        await persist({ step: "replacement-staged", replacement });
      }
      if (receipt.step === "replacement-staged") {
        if (!receipt.replacement) throw new Error("replacement identity is missing");
        const staged = stage.inspect("replacement");
        if (staged) {
          if (!matchesCaptured(staged, receipt.replacement)) throw new Error("staged replacement changed");
          stage.moveExclusive("replacement", parent, name);
          parent.sync();
          stage.sync();
        }
        verifyPostcondition();
        await persist({ step: "committed" });
      }
      if (receipt.step !== "committed") throw new Error("unexpected restoration recovery stage");
      verifyPostcondition();
      if (stage.inspect("original")) {
        verifyCaptured(stage, "original", approval);
        stage.unlink("original", "file");
        stage.sync();
      }
    }
    verifyPostcondition();
    await persist({ step: "finished" });
    // Only a now-empty private directory is removed. Unknown children are never recursed.
    parent.unlink(receipt.stageName, "directory");
    parent.sync();
    return receipt;
  } catch (error) {
    // Roll back only before a restore has committed and only into an unoccupied name. If the
    // original was substituted or a new path appeared, preserve both for manual reconciliation.
    if (stage && ["staged", "quarantined", "replacement-staged"].includes(receipt.step)) {
      try {
        if (stage.inspect("original") && !parent.inspect(name)) {
          stage.moveExclusive("original", parent, name);
          parent.sync();
          stage.sync();
        }
      } catch {
        /* The staged object remains retained; no overwrite fallback. */
      }
    }
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await persist({ step: "retained", reason });
    } catch {
      /* Last durable cursor remains authoritative. */
    }
    throw new Error(`${reason}; recovery staging: ${dirname(expected.path)}/${receipt.stageName}`, { cause: error });
  } finally {
    stage?.close();
    parent.close();
  }

  function verifyPostcondition(): void {
    const currentParent = descriptorIdentity(parent.fd);
    const ancestors = { ...expected.ancestors };
    delete ancestors[expected.path];
    if (
      !(["dev", "ino", "kind", "mode", "uid", "gid"] as const).every((key) => currentParent[key] === expected.parent[key]) ||
      !sameFilesystemIdentity(ancestors, filesystemIdentity(dirname(expected.path)))
    ) {
      throw new Error("ancestor namespace changed during application; the new namespace was preserved");
    }
    const actual = parent.inspect(name);
    if (approval.action === "remove") {
      if (actual) throw new Error("removed name was reoccupied; the new object was preserved");
    } else {
      if (
        !receipt.replacement ||
        !matchesCaptured(actual, receipt.replacement) ||
        !actual ||
        parent.hash(name, actual) !== new Bun.CryptoHasher("sha256").update(options.bytes!).digest("hex")
      ) {
        throw new Error("restoration postcondition changed; a newer object was preserved");
      }
    }
  }
}

export function validNativeReceipt(value: unknown): value is NativeActionReceipt {
  if (typeof value !== "object" || value === null) return false;
  const receipt = value as Partial<NativeActionReceipt>;
  return (
    receipt.version === 1 &&
    typeof receipt.path === "string" &&
    receipt.path.startsWith("/") &&
    typeof receipt.stageName === "string" &&
    /^\.tret-stage-[0-9a-f-]{36}$/.test(receipt.stageName) &&
    ["prepared", "staged", "quarantined", "replacement-staged", "committed", "finished", "retained"].includes(
      String(receipt.step),
    )
  );
}
