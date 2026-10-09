import { afterEach, describe, expect, test } from "bun:test";
import { checkForUpdate, clearUpdateCheck } from "./updatecheck";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostArtifact } from "./artifacts";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME_BACKUP = process.env.HOME;
const FETCH_BACKUP = globalThis.fetch;
let testHome: string | undefined;

afterEach(() => {
  if (HOME_BACKUP === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = HOME_BACKUP;
  }
  globalThis.fetch = FETCH_BACKUP;
  if (testHome) {
    rmSync(testHome, { recursive: true, force: true });
    testHome = undefined;
  }
});

function useTestHome(): string {
  testHome = mkdtempSync(join(tmpdir(), "tret-update-check-test-"));
  process.env.HOME = testHome;
  return testHome;
}

function mockReleaseFetch(binaryContents: string): void {
  const artifact = hostArtifact();
  if (!artifact) throw new Error("test host is not a supported platform");
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(binaryContents);
  const checksum = hasher.digest("hex");
  globalThis.fetch = (async (input) => {
    if (String(input).includes("api.github.com")) {
      return new Response(JSON.stringify([{ tag_name: "v0.2.0" }]));
    }
    // The release manifest names the running platform's artifact, the way the
    // published checksums.txt does. The archive line (with a deliberately wrong
    // hash) is present too: the check must pick the raw-binary entry, not the
    // archive that merely shares the artifact's prefix.
    return new Response(`${checksum}  ${artifact.binary}\n${"0".repeat(64)}  ${artifact.archive}\n`);
  }) as typeof fetch;
}

describe("update check", () => {
  test("ignores cache write failures and cleans up the temporary file", async () => {
    const home = useTestHome();
    const binaryContents = "installed binary";
    mkdirSync(join(home, ".tret/bin"), { recursive: true });
    writeFileSync(join(home, ".tret/bin/tret"), binaryContents);
    mkdirSync(join(home, ".tret/update-check.json"));
    mockReleaseFetch(binaryContents);

    await checkForUpdate();

    expect(readdirSync(join(home, ".tret")).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  test("writes the cache and leaves no temporary files", async () => {
    const home = useTestHome();
    const binaryContents = "installed binary";
    mkdirSync(join(home, ".tret/bin"), { recursive: true });
    writeFileSync(join(home, ".tret/bin/tret"), binaryContents);
    mockReleaseFetch(binaryContents);

    await checkForUpdate();

    const cache = JSON.parse(readFileSync(join(home, ".tret/update-check.json"), "utf8"));
    expect(cache).toMatchObject({ tag: "v0.2.0", outdated: false });
    expect(readdirSync(join(home, ".tret")).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  test("reports an update when the installed binary differs from the release", async () => {
    const home = useTestHome();
    mkdirSync(join(home, ".tret/bin"), { recursive: true });
    writeFileSync(join(home, ".tret/bin/tret"), "an older build");
    mockReleaseFetch("the newer build");

    await checkForUpdate();

    const cache = JSON.parse(readFileSync(join(home, ".tret/update-check.json"), "utf8"));
    expect(cache).toMatchObject({ tag: "v0.2.0", outdated: true });
  });

  test("skips the check on an unsupported platform", async () => {
    const home = useTestHome();
    mkdirSync(join(home, ".tret/bin"), { recursive: true });
    writeFileSync(join(home, ".tret/bin/tret"), "installed binary");

    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("{}");
    }) as typeof fetch;
    try {
      await checkForUpdate();
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }

    expect(fetched).toBe(false);
  });

  test("ignores cache removal failures", () => {
    const home = useTestHome();
    mkdirSync(join(home, ".tret/update-check.json"), { recursive: true });

    expect(() => clearUpdateCheck()).not.toThrow();
  });
});
