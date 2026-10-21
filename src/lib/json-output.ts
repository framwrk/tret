// Machine-readable output (plan 03 item 5).
//
// JSON mode exists so scripts can consume Tret's results without parsing human text. Its one
// invariant is that stdout carries a single JSON document and nothing else: every human line —
// progress, warnings, installer output, and prompts — is routed to the terminal or stderr by
// `log()`/`runInstaller`, so a piped `--json` run stays valid JSON. Commands must never prompt in
// JSON mode; a run that needs input fails with a structured error instead of mixing a question into
// the data stream.

/** True while this run is producing structured output instead of human text. */
let jsonMode = false;

/** Turns JSON mode on for this run; set once from the parsed command line. */
export function enableJsonMode(): void {
  jsonMode = true;
}

/** Whether this run must keep stdout free of human text. */
export function isJsonMode(): boolean {
  return jsonMode;
}

/**
 * Writes one JSON document to stdout. This is the only function that may write to stdout in JSON
 * mode; a human `log()` call never does.
 */
export function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** The document JSON mode prints for a failed run; the same message also goes to the terminal. */
export type JsonErrorDocument = {
  ok: false;
  error: { code: string; message: string };
};

/** Builds the stable error document for `code`; kept separate so tests can assert its shape. */
export function jsonErrorDocument(code: string, message: string): JsonErrorDocument {
  return { ok: false, error: { code, message } };
}

/** Emits a JSON error document when JSON mode is on; a no-op otherwise. */
export function emitJsonError(code: string, message: string): void {
  if (jsonMode) emitJson(jsonErrorDocument(code, message));
}
