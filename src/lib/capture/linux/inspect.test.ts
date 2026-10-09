import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { captureBaseline } from "./inspect";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The baseline walk records an excluded directory itself but never descends into it, matching the
// snapshot walk's skip rules. Without the prune, every Linux capture-enabled install recurses the
// whole observe scope one `readdir` at a time, and a runner's multi-GB `/opt/hostedtoolcache`
// (`cache`) or a vendored `node_modules` runs the install tests past their timeout.

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tret-baseline-"));
  roots.push(root);
  return root;
}

describe("linux capture baseline", () => {
  test("records excluded directories but does not descend into them", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "kept"), { recursive: true });
    await writeFile(join(root, "kept", "file"), "kept\n");
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(root, "node_modules", "pkg", "junk"), "junk\n");
    await mkdir(join(root, "cache", "blobs"), { recursive: true });
    await writeFile(join(root, "cache", "blobs", "junk"), "junk\n");

    const baseline = await captureBaseline([root]);

    // The root and its kept subtree are walked as before.
    expect(baseline.existed(root)).toBe(true);
    expect(baseline.kind(root)).toBe("directory");
    expect(baseline.existed(join(root, "kept"))).toBe(true);
    expect(baseline.existed(join(root, "kept", "file"))).toBe(true);

    // The excluded directories are still recorded...
    expect(baseline.existed(join(root, "node_modules"))).toBe(true);
    expect(baseline.kind(join(root, "node_modules"))).toBe("directory");
    expect(baseline.existed(join(root, "cache"))).toBe(true);
    // ...but nothing beneath them is.
    expect(baseline.existed(join(root, "node_modules", "pkg"))).toBe(false);
    expect(baseline.existed(join(root, "node_modules", "pkg", "junk"))).toBe(false);
    expect(baseline.existed(join(root, "cache", "blobs"))).toBe(false);
    expect(baseline.existed(join(root, "cache", "blobs", "junk"))).toBe(false);
  });
});
