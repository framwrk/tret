import { EXIT_BLOCKED, EXIT_NOT_FOUND, EXIT_USAGE } from "../constants";
import { confirm, log } from "../lib/utilities";
import { emitJson, isJsonMode } from "../lib/json-output";
import { FileStorage } from "../lib/store";
import { fail } from "../lib/failure";
import { operationSummary } from "../lib/operation-log";
import { resumeOperation } from "../lib/recovery";

export async function recover(id: string | undefined, action: "inspect" | "resume" | "discard", yes: boolean): Promise<void> {
  if (action !== "inspect" && !id) fail("recover-usage", "recovery mutations require one operation id", EXIT_USAGE);
  const storage = new FileStorage();
  const operations = storage.operations.list();
  const selected = id ? operations.filter((operation) => operation.id === id) : operations;
  if (id && !selected.length) fail("recover-not-found", `operation not found: ${id}`, EXIT_NOT_FOUND);
  if (action !== "inspect") {
    if (!yes && (isJsonMode() || !process.stdin.isTTY))
      fail("recover-consent", "pass --yes to authorize this recovery decision", EXIT_BLOCKED);
    const staging = Object.values(selected[0]!.application?.native ?? {}).map(
      (receipt) => `${receipt.path}: ${receipt.stageName}`,
    );
    for (const path of staging) log(`retained recovery location: ${path}`);
    if (!yes && !confirm(`${action} operation ${id}? external code will not be run [y/N]`))
      fail("recover-consent", "recovery decision was declined", EXIT_BLOCKED);
    try {
      const operation =
        action === "resume"
          ? await resumeOperation(storage, id!)
          : await storage.withOperation(async () => storage.operations.discard(id!), true);
      if (isJsonMode()) emitJson({ ok: true, command: "recover", action, operation: operationSummary(operation) });
      else log(`${action}: ${operation.id} (${operation.stage}); ${operation.reason ?? "evidence retained"}`);
      return;
    } catch (error) {
      fail("recover-blocked", error instanceof Error ? error.message : String(error), EXIT_BLOCKED);
    }
  }
  if (isJsonMode()) emitJson({ ok: true, command: "recover", operations: selected.map(operationSummary) });
  else
    for (const operation of selected)
      log(`${operation.id} ${operation.kind} ${operation.stage}${operation.reason ? `: ${operation.reason}` : ""}`);
}
