import { describe, expect, test } from "bun:test";
import { extractUrl } from "./utilities";

describe("extractUrl", () => {
  test("reads the URL from a pasted curl command", () => {
    expect(extractUrl("curl -fsSL https://opencode.ai/v2/install | bash")).toBe("https://opencode.ai/v2/install");
  });

  test("stops at the pipe of a quoted paste", () => {
    expect(extractUrl(`curl -fsSL 'https://omp.sh/install' | sh`)).toBe("https://omp.sh/install");
  });

  test("returns a bare URL unchanged", () => {
    expect(extractUrl("https://tret.framwrk.com/scripts/install.sh")).toBe("https://tret.framwrk.com/scripts/install.sh");
  });

  test("returns undefined for text without a URL", () => {
    expect(extractUrl("curl | bash")).toBeUndefined();
    expect(extractUrl("")).toBeUndefined();
  });
});
