import { CaptureBudget, CaptureBudgetError, DEFAULT_CAPTURE_LIMITS } from "./capture/budget";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { MACOS_PLATFORM } from "./platform";
import { adoptedEntries } from "./adoption";
import { findRelated } from "./related";
import { join } from "node:path";
import { tmpdir } from "node:os";

const homes: string[] = [],
  previousHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = previousHome;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "tret-related-budget-"));
  homes.push(home);
  process.env.HOME = home;
  const executable = join(home, "tool/bin/tool");
  mkdirSync(join(home, "tool/bin"), { recursive: true });
  writeFileSync(executable, "command");
  writeFileSync(join(home, "tool/payload"), "payload");
  writeFileSync(join(home, "tool.conf"), "config");
  writeFileSync(join(home, "unrelated"), "unrelated");
  return { home, executable, platform: { ...MACOS_PLATFORM, searchRootsInHome: [], searchRootsAbsolute: [] } };
}

test("find discovery and descendant fingerprinting share a single node budget", () => {
  const { executable, platform } = fixture();
  const budget = new CaptureBudget({ ...DEFAULT_CAPTURE_LIMITS, maxNodes: 6 });
  const paths = findRelated("tool", executable, platform, budget);
  expect(budget.used.nodes).toBeGreaterThan(0);
  expect(() => adoptedEntries(paths, budget)).toThrow(CaptureBudgetError);
});

test("find does not swallow deadline exhaustion while enumerating a search root", () => {
  const { executable, platform } = fixture();
  let ticks = 0;
  const budget = new CaptureBudget({ ...DEFAULT_CAPTURE_LIMITS, maxWorkMs: 4 }, () => ++ticks);
  expect(() => findRelated("tool", executable, platform, budget)).toThrow("active work milliseconds");
});

test("discovery counts unmatched entries and preserves top-most matches across lexical siblings", () => {
  const { home, executable, platform } = fixture();
  const budget = new CaptureBudget();
  expect(findRelated("tool", executable, platform, budget)).toEqual([join(home, "tool"), join(home, "tool.conf")]);
  expect(budget.used.nodes).toBeGreaterThanOrEqual(4);
});

test("unreadable discovery is a visible loss; absent roots stay ordinary and no unbounded read is used", async () => {
  const { home, executable } = fixture();
  const denied = join(home, "denied"),
    absent = join(home, "absent"),
    script = join(home, "probe.ts");
  writeFileSync(
    script,
    `
    import * as fs from 'node:fs';
    import { mock } from 'bun:test';
    const real={...fs};
    mock.module('node:fs',()=>({...real,
      readdirSync:()=>{throw new Error('unbounded discovery read');},
      opendirSync:(path,options)=>{
        if(path===${JSON.stringify(denied)})throw Object.assign(new Error('injected EACCES'),{code:'EACCES'});
        return real.opendirSync(path,options);
      }
    }));
    const {findRelated}=await import(${JSON.stringify(join(import.meta.dir, "related.ts"))});
    const {CaptureBudget}=await import(${JSON.stringify(join(import.meta.dir, "capture/budget.ts"))});
    const budget=new CaptureBudget();
    const paths=findRelated('tool',${JSON.stringify(executable)},{searchRootsInHome:[],searchRootsAbsolute:[${JSON.stringify(denied)},${JSON.stringify(absent)}]},budget);
    console.log(JSON.stringify({paths,resources:budget.report()}));
  `,
  );
  const child = Bun.spawn([process.execPath, script], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  const result = JSON.parse(out);
  expect(result.paths).toContain(join(home, "tool"));
  expect(result.resources.losses).toEqual([expect.stringContaining(`discovery directory unreadable: ${denied}`)]);
});
