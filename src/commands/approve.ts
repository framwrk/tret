import { EXIT_AMBIGUOUS, EXIT_BLOCKED, EXIT_NOT_FOUND, EXIT_USAGE } from "../constants";
import { candidateEffects, observedRecord } from "../lib/records-v4";
import { cleanupSnapshot, protectedCleanupPath } from "../lib/cleanup-authority";
import { confirm, log } from "../lib/utilities";
import { emitJson, isJsonMode } from "../lib/json-output";
import { formatSelectionCandidates, selectRecord } from "../lib/record-selection";
import { FileStorage } from "../lib/store";
import { cleanupClaimChecker } from "../lib/delegated-removal";
import { fail } from "../lib/failure";
import { recordTarget } from "../lib/record-target";
import { resolve } from "node:path";
import { runStoreOperation } from "../lib/command-operation";

/** One explicit action on one current object; execution consent never supplies this decision. */
export async function approve(
  selector: string | undefined,
  rawPath: string | undefined,
  action: "remove" | "restore" | "revoke",
  yes: boolean,
): Promise<void> {
  if (!selector || !rawPath || rawPath.includes("\0") || rawPath.split("/").includes(".."))
    fail("approve-usage", "approve requires a tool and one path without parent traversal", EXIT_USAGE);
  if (!yes && (isJsonMode() || !process.stdin.isTTY))
    fail(
      "approve-consent",
      "pass --yes to approve this exact cleanup action without an interactive confirmation",
      EXIT_BLOCKED,
    );
  const storage = new FileStorage();
  if (!storage.inOperation) return runStoreOperation(storage, () => approve(selector, rawPath, action, yes));
  const records = await storage.loadRecords();
  const selection = selectRecord(records, selector);
  if (!selection.ok) {
    if (selection.reason === "ambiguous") {
      for (const candidate of formatSelectionCandidates(selection)) log(`\t${candidate}`);
      fail("approve-ambiguous", selection.message, EXIT_AMBIGUOUS);
    }
    fail("approve-not-found", selection.message, EXIT_NOT_FOUND);
  }
  let record = selection.record;
  const path = resolve(rawPath);
  const candidates = candidateEffects(record).filter(
    (candidate) =>
      candidate.path === path &&
      (action === "revoke" || (action === "remove" ? candidate.section === "owned" : candidate.section !== "owned")),
  );
  if (candidates.length !== 1)
    fail(
      "approve-path",
      "the path must identify exactly one recorded candidate for this action; inspect the record first",
      EXIT_BLOCKED,
    );
  if (action === "revoke") {
    const candidate = candidates[0]!;
    const evidence = record.evidence!.map((entry) =>
      entry.id === candidate.id
        ? {
            id: entry.id,
            path: entry.path,
            section: entry.section,
            origin: entry.origin,
            attribution: entry.attribution,
            beforeImage: entry.beforeImage,
            authority: "none" as const,
          }
        : entry,
    );
    const saved = await storage.saveRecord({ ...record, evidence });
    if (isJsonMode())
      emitJson({
        ok: true,
        command: "approve",
        tool: record.name,
        id: record.id,
        revision: saved.revision,
        path,
        action,
        authority: "none",
      });
    else log(`revoked cleanup approval for ${record.name}: ${path}; target files were unchanged`);
    return;
  }
  const scoped = recordTarget(record).record;
  if (![...scoped.owned, ...scoped.mutated, ...scoped.deleted].some((entry) => entry.path === path)) {
    fail(
      "approve-scope",
      "this candidate is inside an unverified managed payload; manual reconciliation is required",
      EXIT_BLOCKED,
    );
  }
  const protectedReason = protectedCleanupPath(path);
  if (protectedReason) fail("approve-protected", `${path}: ${protectedReason}`, EXIT_BLOCKED);
  if (cleanupClaimChecker(records, record)(path))
    fail(
      "approve-shared",
      `${path} overlaps another record's claim or managed scope; resolve shared claims first`,
      EXIT_BLOCKED,
    );
  let current;
  try {
    current = cleanupSnapshot(path);
  } catch (error) {
    fail("approve-unverifiable", error instanceof Error ? error.message : String(error), EXIT_BLOCKED);
  }
  if (action === "remove" && !current.node)
    fail("approve-absent", "the candidate is already absent; there is no current object to approve", EXIT_BLOCKED);
  if (action === "remove") {
    const node = current.node!;
    record = observedRecord(
      {
        ...record,
        owned: record.owned.map((entry) =>
          entry.path === path && (entry.kind === "unknown" || (entry.kind === "file" && !entry.installedHash))
            ? {
                path,
                kind: node.kind === "unsupported" ? "unknown" : node.kind,
                ...(current.hash ? { installedHash: current.hash } : {}),
                ...(current.linkTarget !== undefined ? { linkTarget: current.linkTarget } : {}),
              }
            : entry,
        ),
      },
      record.revision!,
      "adoption",
      true,
    );
  }
  if (action === "restore") {
    const entry = [...record.mutated, ...record.deleted].find((entry) => entry.path === path)!;
    if (!entry.beforeBlob || (entry.mode !== undefined && (entry.mode & 0o7000) !== 0))
      fail("approve-restore", "supported before-image bytes and ordinary permission bits are required", EXIT_BLOCKED);
    let bytes;
    try {
      bytes = await storage.getBlob(entry.beforeBlob);
    } catch {
      fail("approve-blob", "the required before-image failed integrity verification", EXIT_BLOCKED);
    }
    if (!bytes || (entry.beforeHash !== undefined && entry.beforeHash !== entry.beforeBlob))
      fail("approve-blob", "the required before-image is missing or inconsistent", EXIT_BLOCKED);
    if (current.node && current.node.kind !== "file")
      fail("approve-type", "restoring this node type requires manual reconciliation", EXIT_BLOCKED);
    log(`restore ${path} from before-image ${entry.beforeBlob} (${bytes.byteLength} bytes)`);
  } else log(`remove the exact current ${current.node!.kind} at ${path}`);
  log("this is user-authorized cleanup; it does not prove installer ownership or historical reversal");
  if (!yes && !confirm("approve this action on this object? [y/N]"))
    fail("approve-consent", "cleanup approval was declined", EXIT_BLOCKED);
  const candidate = candidateEffects(record).find(
    (entry) => entry.path === path && (action === "remove" ? entry.section === "owned" : entry.section !== "owned"),
  )!;
  const evidence = record.evidence!.map((entry) =>
    entry.id === candidate.id
      ? {
          ...entry,
          authority: "user-approved" as const,
          approval: { action, approvedAt: new Date().toISOString(), current },
        }
      : entry,
  );
  const saved = await storage.saveRecord({ ...record, evidence });
  if (isJsonMode())
    emitJson({
      ok: true,
      command: "approve",
      tool: record.name,
      id: record.id,
      revision: saved.revision,
      path,
      action,
      authority: "user-approved",
    });
  else log(`approved ${action} for ${record.name}: ${path}`);
}
