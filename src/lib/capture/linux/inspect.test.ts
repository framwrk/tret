import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

/** sha256 content address, matching the before-image blob ids. */
function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
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

    const { baseline } = await captureBaseline([root]);

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

describe("linux capture baseline: before-images", () => {
  test("does not reread files reached through overlapping observe roots", async () => {
    const root = await makeRoot();
    const nested = join(root, "nested");
    const file = join(nested, "config");
    await mkdir(nested);
    await writeFile(file, "original-config\n");

    const reads: string[] = [];
    await captureBaseline([root, nested], {
      backups: { enabled: true, sizeLimitBytes: 1024 },
      read: async (path) => {
        reads.push(path);
        return new Uint8Array(await readFile(path));
      },
    });

    expect(reads).toEqual([file]);
  });

  test("reads eligible file bytes and their prior metadata when backups are enabled", async () => {
    const root = await makeRoot();
    const file = join(root, "config");
    await writeFile(file, "original-config\n");
    await chmod(file, 0o640);

    const { baseline, beforeImages } = await captureBaseline([root], {
      backups: { enabled: true, sizeLimitBytes: 1024 },
    });

    // The pre-window hash/size/mode travel with the baseline, so a later overwrite can be told from
    // a create and described with its prior bits...
    expect(baseline.metadata(file)).toMatchObject({
      kind: "file",
      hash: sha256("original-config\n"),
      size: 16,
      mode: 0o640,
    });
    // ...and the bytes are kept under their content address for the eventual restore.
    const hash = sha256("original-config\n");
    expect(beforeImages.has(hash)).toBe(true);
    expect(new TextDecoder().decode(beforeImages.get(hash))).toBe("original-config\n");
  });

  test("leaves over-limit and unreadable files kind-only", async () => {
    const root = await makeRoot();
    const big = join(root, "big");
    await writeFile(big, "01234567890");
    const atLimit = join(root, "at-limit");
    await writeFile(atLimit, "0123456789");
    const blocked = join(root, "blocked");
    await writeFile(blocked, "secret\n");

    const { baseline, beforeImages } = await captureBaseline([root], {
      backups: { enabled: true, sizeLimitBytes: 10 },
      read: async (path) => (path === blocked ? undefined : new Uint8Array(await readFile(path))),
    });

    expect(beforeImages.size).toBe(1);
    expect(beforeImages.has(sha256("0123456789"))).toBe(true);
    expect(baseline.metadata(atLimit)).toMatchObject({ kind: "file", size: 10, hash: sha256("0123456789") });
    // The over-limit and unreadable files are still recorded and attributable without a before-image.
    expect(baseline.kind(big)).toBe("file");
    expect(baseline.metadata(big)).toBeUndefined();
    expect(baseline.kind(blocked)).toBe("file");
    expect(baseline.metadata(blocked)).toBeUndefined();
  });

  test("reads no file content when backups are off", async () => {
    const root = await makeRoot();
    const file = join(root, "config");
    await writeFile(file, "original-config\n");

    const { baseline, beforeImages } = await captureBaseline([root]);

    expect(beforeImages.size).toBe(0);
    expect(baseline.kind(file)).toBe("file");
    expect(baseline.metadata(file)).toBeUndefined();
  });
});
