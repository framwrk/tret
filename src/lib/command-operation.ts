import { CaptureBudgetError, CaptureLimitError } from "./capture/budget";
import { EXIT_BLOCKED, EXIT_USAGE } from "../constants";
import { FileStorage, RecordRevisionError, RecordsLockedError } from "./store";
import { RecoveryLimitError, RecoveryRetentionError } from "./recovery-retention";
import { CaptureConsentError } from "./capture/preflight";
import { EXIT_ERROR } from "../constants";
import { OperationLockedError } from "./operation-lease";
import { OperationRecoveryRequiredError } from "./operation-log";
import { fail } from "./failure";

/** Known store refusals are actionable CLI errors, including after a stale preview. */
export async function runStoreOperation<T>(storage: FileStorage, work: () => Promise<T>): Promise<T> {
  try {
    return await storage.withOperation(work);
  } catch (error) {
    if (error instanceof RecoveryLimitError) fail("recovery-limits", error.message, EXIT_USAGE);
    if (error instanceof RecoveryRetentionError)
      fail(error.executionMayHaveStarted ? "recovery-evidence-partial" : "recovery-retention", `${error.message}${error.executionMayHaveStarted ? "; an operation may have started; its last durable checkpoint is retained" : ""}`, error.executionMayHaveStarted ? EXIT_ERROR : EXIT_BLOCKED);
    if (error instanceof CaptureLimitError) fail("capture-limits", error.message, EXIT_USAGE);
    if (error instanceof CaptureBudgetError) fail("capture-budget", error.message, EXIT_BLOCKED);
    if (error instanceof CaptureConsentError) fail("capture-consent", error.message, EXIT_BLOCKED);
    if (error instanceof OperationLockedError || error instanceof RecordsLockedError)
      fail("operation-locked", error.message, EXIT_BLOCKED);
    if (error instanceof OperationRecoveryRequiredError) fail("operation-recovery-required", error.message, EXIT_BLOCKED);
    if (error instanceof RecordRevisionError) fail("record-changed", error.message, EXIT_BLOCKED);
    throw error;
  }
}
