import { cleanupSnapshot, sameApprovedSnapshot } from "../cleanup-authority";
import { delegatedRemovalBlocks, recordTarget } from "../record-target";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { migrateRecordFileV2ToV3 } from "../records";
import { readRecordFile } from "../records-v4";
import { unverifiedShellEdits } from "../shellconfig";

/**
 * Positive CLI fixtures explicitly consent to each supported candidate before testing cleanup.
 * Default/legacy authority refusal has separate end-to-end coverage in authority-safety.test.ts.
 * Unknown-kind legacy entries are deliberately not adopted by this fixture convenience function.
 * Failed approvals (shared/protected/unrestorable paths) remain blocked for the caller's assertions.
 */
export async function approveFixtureCandidates(home: string, args: string[], invocation?: string[]): Promise<void> {
  const own = args.filter((arg) => arg !== "--json");
  const command = own[0];
  if (
    command !== "uninstall" &&
    !(command === "install" && own.includes("--force")) &&
    !(command === "update" && own.some((arg, index) => index > 0 && !arg.startsWith("--")))
  )
    return;
  const path = join(home, ".tret", "records.json");
  if (!existsSync(path)) return;
  let records;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    // Validate through the legacy reader as well: the helper must not repair malformed fixtures.
    if (typeof parsed === "object" && parsed !== null && "version" in parsed && parsed.version !== 4)
      migrateRecordFileV2ToV3(parsed);
    records = readRecordFile(parsed).records;
  } catch {
    return;
  }
  const cli = join(import.meta.dir, "../../../index.ts");
  for (const record of records) {
    const approvedRemovals = new Set<string>();
    const selector = own.slice(1).find((arg) => !arg.startsWith("--"));
    if (command === "install" ? !own.includes(record.url) : selector !== record.id && selector !== record.name) continue;
    if (
      !own.includes("--approved-only") &&
      (unverifiedShellEdits(record, undefined, home).length || delegatedRemovalBlocks(recordTarget(record, home)).length)
    )
      continue;
    const paths = [...record.owned, ...record.mutated, ...record.deleted].map((entry) => entry.path);
    if (
      records.some(
        (other) =>
          other.id !== record.id &&
          [...other.owned, ...other.mutated, ...other.deleted].some((entry) => paths.includes(entry.path)),
      )
    )
      continue;
    const entries = [
      ...record.owned.map((entry) => ({ ...entry, action: "remove" as const })),
      ...[...record.mutated, ...record.deleted]
        .filter((entry) => entry.beforeBlob)
        .map((entry) => ({ ...entry, action: "restore" as const })),
    ].sort((a, b) => b.path.split("/").length - a.path.split("/").length);
    for (const entry of entries) {
      if ("kind" in entry && entry.kind === "unknown") continue;
      try {
        const current = cleanupSnapshot(entry.path);
        if ("kind" in entry && entry.kind !== current.node?.kind) continue;
        if (
          entry.action === "remove" &&
          "installedHash" in entry &&
          entry.installedHash &&
          current.hash !== entry.installedHash &&
          !own.includes("--force")
        )
          continue;
        if (
          "kind" in entry &&
          entry.kind === "directory" &&
          readdirSync(entry.path).some((name) => !approvedRemovals.has(join(entry.path, name)))
        )
          continue;
        const prior = record.evidence.find(
          (candidate) => candidate.path === entry.path && candidate.authority === "user-approved",
        );
        if (prior?.authority === "user-approved" && sameApprovedSnapshot(prior.approval.current, current)) {
          if (entry.action === "remove") approvedRemovals.add(entry.path);
          continue;
        }
      } catch {
        continue;
      }
      const proc = Bun.spawn(
        [...(invocation ?? [process.execPath, cli]), "--json", "approve", record.id, entry.path, `--${entry.action}`, "--yes"],
        {
          env: { ...process.env, HOME: home },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      if (code === 0 && entry.action === "remove") approvedRemovals.add(entry.path);
    }
  }
}
