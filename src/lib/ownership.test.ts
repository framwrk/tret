import { describe, expect, test } from "bun:test";
import { ownershipConfidence, ownershipMarker, ownershipNote } from "./ownership";

describe("ownership confidence", () => {
  test("only a complete capture proves the installer created a path", () => {
    expect(ownershipConfidence("complete")).toBe("proven");
    expect(ownershipConfidence("partial")).toBe("observed");
    expect(ownershipConfidence("heuristic")).toBe("observed");
  });

  test("an observed path is marked and a proven path is not", () => {
    expect(ownershipMarker("observed")).toBe(" (observed, not proven)");
    expect(ownershipMarker("proven")).toBe("");
  });

  test("only an observed record carries the caveat", () => {
    expect(ownershipNote("proven")).toBeUndefined();
    expect(ownershipNote("observed")).toContain("not proven to belong to this tool");
  });
});
