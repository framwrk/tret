import { afterEach, describe, expect, test } from "bun:test";
import { checkForUpdate, clearUpdateCheck } from "./updatecheck";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(binaryContents);
  const checksum = hasher.digest("hex");
  globalThis.fetch = (async (input) => {
    if (String(input).includes("api.github.com")) {
      return new Response(JSON.stringify([{ tag_name: "v0.2.0" }]));
    }
    return new Response(`${checksum}  tret-macos-arm64\n`);
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

  test("ignores cache removal failures", () => {
    const home = useTestHome();
    mkdirSync(join(home, ".tret/update-check.json"), { recursive: true });

    expect(() => clearUpdateCheck()).not.toThrow();
  });
});
