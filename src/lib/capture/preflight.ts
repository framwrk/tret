import { confirm, log } from "../utilities";
import type { BackupPolicy } from "./normalize";
import type { CaptureBackend } from "./backend";
import { heuristicFallbackRoots } from "./fallback";
import { isJsonMode } from "../json-output";

export class CaptureConsentError extends Error {
  constructor(reason: string) {
    super(
      `${reason}; pass --allow-weaker-capture to accept heuristic or no-window observations for this execution; --yes grants execution consent only`,
    );
    this.name = "CaptureConsentError";
  }
}

/** A fresh decision for this invocation, never a saved capture setting or cleanup authority. */
export async function prepareCapture(options: {
  primary: CaptureBackend;
  fallback: CaptureBackend;
  roots: string[];
  backups: BackupPolicy;
  enabled?: boolean;
  allowWeakerCapture?: boolean;
}) {
  let accepted = options.allowWeakerCapture === true;
  const plan = {
    fallback: options.fallback,
    backend: options.enabled === false ? undefined : options.primary,
    roots: [...options.roots],
    beforeFallback: async (error: unknown) => {
      plan.backend = options.fallback;
      plan.roots = heuristicFallbackRoots(options.roots);
      reason = `preferred capture could not attach: ${message(error)}`;
      show(reason);
      await acceptWeaker();
    },
    beforeLegacy: async () => {
      plan.backend = undefined;
      plan.roots = options.enabled === false ? [...options.roots] : heuristicFallbackRoots(options.roots);
      reason = "no capture window is available; only metadata snapshots can observe persistent changes";
      show(reason);
      await acceptWeaker();
    },
  };
  let reason = options.enabled === false ? "capture was disabled" : "selected capture is heuristic or partial";
  if (plan.backend) {
    try {
      await plan.backend.preflight?.();
    } catch (error) {
      reason = `preferred capture is unavailable: ${message(error)}`;
      plan.backend = options.fallback;
      plan.roots = heuristicFallbackRoots(options.roots);
    }
  }
  show(reason);
  if (!plan.backend || plan.backend.completeness !== "complete") await acceptWeaker();
  return plan;

  async function acceptWeaker() {
    if (accepted) return;
    if (
      !isJsonMode() &&
      process.stdin.isTTY &&
      confirm("allow heuristic or no-window observations for this execution? [y/N]") === true
    ) {
      accepted = true;
      return;
    }
    throw new CaptureConsentError(reason);
  }
  function show(detail: string) {
    log(`capture preflight: ${plan.backend?.name ?? "disabled (metadata snapshots)"}`);
    if (!plan.backend || plan.backend.completeness !== "complete" || plan.backend !== options.primary) log(`\t${detail}`);
    for (const root of plan.roots) log(`\tobserve ${root}`);
    for (const root of options.roots.filter((root) => !plan.roots.includes(root))) log(`\texcluded from fallback: ${root}`);
    log("\tprivate Tret state and reserved staging are excluded; sensitive-name exclusions apply to backup content");
    log(
      "\tbackend-specific home, shared package-state and cache exclusions still apply; roots do not include every descendant",
    );
    log(
      !plan.backend
        ? "\tbefore-image backups unavailable without a capture window"
        : options.backups.enabled
          ? `\tbefore-image backups: eligible files up to ${options.backups.sizeLimitBytes} bytes each; aggregate budgets are not yet enforced`
          : "\tbefore-image backups: off; changed existing files may be unrestorable",
    );
    log(
      "\tbounded filesystem observation only; attribution and coverage are verified afterward, not machine-wide completeness",
    );
    if (!plan.backend || plan.backend.completeness !== "complete")
      log(
        "\theuristic/metadata observations cannot attribute background writers or capture every transient or same-stamp change",
      );
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
