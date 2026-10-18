import type { CaptureBackend, CaptureSession, CaptureStartOptions } from "../lib/capture/backend";
import { MemoryBaseline, RealFsInspector } from "../lib/capture/linux/inspect";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import type { AbsolutePath } from "../types";
import type { TracerRecord } from "../lib/capture/linux/raw";
import { install } from "./install";
import { join } from "node:path";
import { reconstruct } from "../lib/capture/linux/reconstruct";
import { tmpdir } from "node:os";

// A resolved-root escape is decided during reconstruction, after the installer has run. This test
// drives the install command end to end with a backend that runs the shipped reconstruction step
// against the real filesystem, so the record path cannot start owning an object outside its roots
// again without failing here. The real ptrace path is covered separately by the Linux smoke test.

const HOMES: { home: string; outside: string }[] = [];
const HOME_BACKUP = process.env.HOME;

afterEach(() => {
  process.env.HOME = HOME_BACKUP;
  while (HOMES.length > 0) {
    const entry = HOMES.pop()!;
    rmSync(entry.home, { recursive: true, force: true });
    rmSync(entry.outside, { recursive: true, force: true });
  }
});

/** Reports the installer's real final state through the shipped reconstruction step. */
class ReconstructingBackend implements CaptureBackend {
  readonly name = "linux-reconstruct-test";
  readonly completeness = "complete";

  constructor(private readonly home: AbsolutePath) {}

  async start(options: CaptureStartOptions): Promise<CaptureSession> {
    return {
      backend: this.name,
      stop: async () => {
        const traced: { records: TracerRecord[]; unsupported: string[]; diagnostics: string[] } = {
          records: [
            { op: "open", at: 1, path: join(this.home, ".local", "bin", "escapetool"), created: true, truncated: false },
            { op: "mkdir", at: 2, path: join(this.home, "visible-dir") },
            // Lexically under the home root, but the parent symlink resolves outside every root.
            { op: "mkdir", at: 3, path: join(this.home, "escaped", "owned-dir") },
          ],
          unsupported: [],
          diagnostics: [],
        };
        const result = await reconstruct({
          traced,
          inspector: new RealFsInspector(),
          baseline: new MemoryBaseline(),
          roots: options.roots,
          fallbackAt: Date.now(),
        });
        // A dropped escape is a coverage loss, not a clean window: report it the way the shipped
        // backend does so the record cannot claim complete attribution over an unobserved write.
        return {
          backend: this.name,
          completeness: result.diagnostics.length === 0 ? this.completeness : "partial",
          ...(result.diagnostics.length === 0 ? {} : { partialReason: result.diagnostics.join("; ") }),
          events: result.events,
        };
      },
    };
  }
}

describe("install capture roots", () => {
  test("a resolved-root escape is never recorded", async () => {
    const home = mkdtempSync(join(tmpdir(), "tret-escape-home-"));
    const outside = mkdtempSync(join(tmpdir(), "tret-escape-outside-"));
    HOMES.push({ home, outside });
    process.env.HOME = home;
    symlinkSync(outside, join(home, "escaped"));

    const script = [
      "#!/bin/bash",
      "set -e",
      'mkdir -p "$HOME/.local/bin"',
      'printf "#!/bin/sh\\necho escapetool\\n" > "$HOME/.local/bin/escapetool"',
      'chmod +x "$HOME/.local/bin/escapetool"',
      'mkdir -p "$HOME/visible-dir"',
      'mkdir -p "$HOME/escaped/owned-dir"',
    ].join("\n");
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(script, { headers: { "content-type": "text/plain" } }),
    });

    try {
      const url = `http://127.0.0.1:${server.port}/install.sh`;
      await install(url, false, [], { backend: new ReconstructingBackend(home), roots: [home] });

      const file = JSON.parse(readFileSync(join(home, ".tret", "records.json"), "utf8")) as {
        records: {
          name: string;
          capture: { completeness: string; segments: { partialReason?: string }[] };
          owned: { path: string }[];
          mutated: { path: string }[];
          deleted: { path: string }[];
        }[];
      };
      const record = file.records.find((entry) => entry.name === "escapetool");
      expect(record).toBeDefined();
      expect(record?.capture.completeness).toBe("partial");
      expect(record?.capture.segments[0]?.partialReason).toContain(join(home, "escaped", "owned-dir"));

      const paths = [...(record?.owned ?? []), ...(record?.mutated ?? []), ...(record?.deleted ?? [])].map(
        (entry) => entry.path,
      );
      expect(paths).toContain(join(home, ".local", "bin", "escapetool"));
      expect(paths).toContain(join(home, "visible-dir"));
      expect(paths.some((path) => path.startsWith(`${outside}/`))).toBe(false);
      expect(paths.some((path) => path.startsWith(`${home}/escaped/`))).toBe(false);
    } finally {
      server.stop(true);
    }
  });
});
