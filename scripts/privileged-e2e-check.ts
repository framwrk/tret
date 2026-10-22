/**
 * Assertions for `scripts/privileged-e2e.sh`. The shell script pipes the JSON documents the shipped
 * `tret` binary prints into this helper, which checks the one property each mode is about and exits
 * non-zero with a clear message when it does not hold.
 *
 * Modes (the JSON document is read from stdin):
 *   `name`          a `tret list --json` document; prints the single tracked tool's name
 *   `installed`     a `tret inspect --json` document; the record is root-privileged and owns the fixture
 *   `requires-sudo` a `tret uninstall --dry-run --json` document; the plan needs sudo for the fixture
 *   `removed`       a `tret uninstall --json` document; the root-owned path was removed
 *   `dropped`       a `tret list --json` document; the tool is no longer tracked
 *
 * The tool name and the fixture path are the two arguments every mode but `name` needs.
 */

/** One owned path as `tret inspect` reports it. */
type InspectOwned = { path: string; kind: string; exists: boolean };

/** One planned uninstall step as `tret inspect` and `tret uninstall --dry-run` report it. */
type PlannedAction = { path: string; action: string };

/** The `tret inspect --json` document; the report itself is under `tool`. */
type InspectDocument = {
  tool: {
    privilege: string;
    executable: string;
    state: string;
    owned: InspectOwned[];
    actions: PlannedAction[];
    requiresSudo: boolean;
  };
};

/** The `tret list --json` document. */
type ListDocument = { tools: { name: string }[] };

/** The `tret uninstall --json` document. */
type UninstallDocument = { ok: boolean; removed: string[] };

const [mode = "", tool = "", entry = ""] = process.argv.slice(2);

/** Reports a failed assertion and ends the run; every mode below returns only on success. */
function fail(message: string): never {
  console.error(`privileged-e2e: ${message}`);
  process.exit(1);
}

const raw = await Bun.stdin.text();
let document: unknown;
try {
  document = JSON.parse(raw);
} catch {
  fail(`could not parse the JSON document: ${raw.slice(0, 200)}`);
}

if (mode !== "name" && (tool === "" || entry === "")) {
  fail("usage: privileged-e2e-check.ts <mode> <tool> <entry>");
}

switch (mode) {
  case "name": {
    const list = document as ListDocument;
    if (list.tools.length !== 1) fail(`expected exactly one tracked tool, found ${list.tools.length}`);
    console.log(list.tools[0]!.name);
    break;
  }

  case "installed": {
    const report = (document as InspectDocument).tool;
    if (report.privilege !== "root") fail(`the record's privilege is ${report.privilege}, expected root`);
    if (report.executable !== entry) fail(`the record's executable is ${report.executable}, expected ${entry}`);
    if (report.state !== "installed") fail(`the record's state is ${report.state}, expected installed`);
    const owned = report.owned.find((path) => path.path === entry);
    if (owned === undefined) fail(`the record does not own ${entry}`);
    if (owned.kind !== "file") fail(`the record owns ${entry} as ${owned.kind}, expected a file`);
    if (!owned.exists) fail(`the record owns ${entry}, but it is not on disk`);
    break;
  }

  case "requires-sudo": {
    const plan = document as { requiresSudo: boolean; actions: PlannedAction[] };
    if (plan.requiresSudo !== true) fail("the plan does not report that sudo is required");
    const planned = plan.actions.find((action) => action.path === entry);
    if (planned === undefined) fail(`the plan does not mention ${entry}`);
    if (planned.action !== "remove") fail(`the plan would ${planned.action} ${entry}, expected remove`);
    break;
  }

  case "removed": {
    const result = document as UninstallDocument;
    if (result.ok !== true) fail("the uninstall did not report success");
    if (!result.removed.includes(entry)) {
      fail(`the uninstall did not remove ${entry}; it removed: ${result.removed.join(", ") || "nothing"}`);
    }
    break;
  }

  case "dropped": {
    const list = document as ListDocument;
    if (list.tools.some((tracked) => tracked.name === tool)) fail(`${tool} is still tracked`);
    break;
  }

  default:
    fail(`unknown mode: ${mode}`);
}
