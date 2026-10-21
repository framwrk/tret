import { type JsonErrorDocument, emitJson, emitJsonError, isJsonMode, jsonErrorDocument } from "./json-output";
import { describe, expect, test } from "bun:test";

// JSON mode's invariant is that stdout carries exactly one JSON document and nothing else. These
// tests capture stdout directly so they fail if a human line ever leaks there, and they pin the
// stable error document automation reads. `jsonMode` is module-global and bun runs every test file
// in one process, so this file never turns it on: leaving it enabled would silently reroute output
// in later files. The enabled path is covered end to end by the command tests that pass `--json`.

/** Runs `run` while capturing everything written to process.stdout. */
function captureStdout(run: () => void): string {
  const original = process.stdout.write;
  let captured = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = original;
  }
  return captured;
}

describe("json-output", () => {
  test("JSON mode is off until it is enabled", () => {
    expect(isJsonMode()).toBe(false);
  });

  test("emitJsonError is a no-op while JSON mode is off", () => {
    expect(captureStdout(() => emitJsonError("boom", "it failed"))).toBe("");
  });

  test("emitJson writes one pretty-printed JSON document with a trailing newline", () => {
    const value = { ok: true, command: "list", tools: ["alpha"] };
    const out = captureStdout(() => emitJson(value));
    expect(out).toBe(`${JSON.stringify(value, null, 2)}\n`);
    expect(out.endsWith("\n")).toBe(true);
    // The document is valid JSON on its own, with no human text around it.
    expect(JSON.parse(out)).toEqual(value);
  });

  test("jsonErrorDocument builds the stable error shape", () => {
    const document: JsonErrorDocument = jsonErrorDocument("inspect-not-found", "no tracked install matches nope");
    expect(document).toEqual({
      ok: false,
      error: { code: "inspect-not-found", message: "no tracked install matches nope" },
    });
  });
});
