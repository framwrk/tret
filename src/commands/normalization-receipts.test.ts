import { afterEach, expect, test } from "bun:test";
import { buildInspectReport, formatInspect } from "./inspect";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { FileStorage } from "../lib/store";
import type { RecordV3 } from "../types";
import { join } from "node:path";
import { tmpdir } from "node:os";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test.each(["install", "trace"] as const)(
  "%s retains normalization explanations in records, receipts and inspect",
  async (kind) => {
    const home = mkdtempSync(join(tmpdir(), "tret-normalization-"));
    homes.push(home);
    const scope = join(home, "scope"),
      target = join(scope, "tool"),
      temp = join(scope, "temp"),
      source = join(scope, "source");
    mkdirSync(scope);
    const storage = new FileStorage({ homeDir: home });
    await storage.prepareCurrentFormat();
    writeFileSync(
      join(home, ".tret/update-check.json"),
      JSON.stringify({ checkedAt: new Date().toISOString(), tag: "v0.0.0", outdated: false }),
    );
    const script =
      '#!/bin/sh\nset -eC\nprintf temporary > "$HOME/scope/temp"\nrm "$HOME/scope/temp"\nprintf "#!/bin/sh\\nexit 0\\n" > "$HOME/scope/source"\nchmod +x "$HOME/scope/source"\nmv "$HOME/scope/source" "$HOME/scope/tool"\n';
    const program = join(home, "program");
    writeFileSync(program, script, { mode: 0o755 });
    if (kind === "trace") {
      const record: RecordV3 = {
        id: "fixture",
        name: "fixture",
        source: "install",
        url: "https://example.com",
        executable: program,
        scriptSha256: "a".repeat(64),
        installedAt: "2026-11-15",
        privilege: "user",
        caseSensitive: true,
        capture: { backend: "fixture", completeness: "complete", segments: [{ kind: "install", startedAt: "2026-11-15" }] },
        owned: [],
        mutated: [],
        deleted: [],
      };
      await storage.saveRecord(record);
    }
    const probe = join(home, "probe.ts");
    writeFileSync(
      probe,
      `
    import { install } from ${JSON.stringify(join(import.meta.dir, "install.ts"))};
    import { trace } from ${JSON.stringify(join(import.meta.dir, "trace.ts"))};
    import { enableJsonMode } from ${JSON.stringify(join(import.meta.dir, "../lib/json-output.ts"))};
    enableJsonMode();
    const backend={name:'fixture',completeness:'complete',start:async()=>({backend:'fixture',stop:async()=>({backend:'fixture',completeness:'complete',events:[
      {type:'create',path:${JSON.stringify(temp)},seq:0,at:1,after:{kind:'file'}},
      {type:'unlink',path:${JSON.stringify(temp)},seq:1,at:2,before:{kind:'file'}},
      {type:'create',path:${JSON.stringify(source)},seq:2,at:3,after:{kind:'file',mode:493}},
      {type:'rename',from:${JSON.stringify(source)},to:${JSON.stringify(target)},seq:3,at:4,destinationBefore:null,after:{kind:'file',mode:493}}
    ]})})};
    ${kind === "install" ? `await install('https://example.com/fixture.sh',false,[],{name:'fixture',yes:true,backend,roots:[${JSON.stringify(scope)}],script:{text:${JSON.stringify(script)},sha256:'a'.repeat(64)}});` : `await trace('fixture',true,{backend,roots:[${JSON.stringify(scope)}]});`}
  `,
    );
    const child = Bun.spawn([process.execPath, probe], {
      env: { ...process.env, HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, ok: JSON.parse(out).ok, err }).toMatchObject({ code: 0, ok: true });
    const record = (await storage.loadRecords())[0]!;
    const normalization = record.capture.segments.at(-1)!.normalization;
    expect(normalization).toMatchObject({ omitted: 0 });
    expect(normalization!.entries.map((entry) => entry.code)).toEqual(["temp-rename", "create-delete"]);
    expect(kind === "install" ? JSON.parse(out).capture.normalization : JSON.parse(out).segment.normalization).toEqual(
      normalization,
    );
    expect(storage.operations.list()[0]!.capture!.normalization).toEqual(normalization);
    const report = await buildInspectReport(record, [record]);
    expect(report.capture.segments.at(-1)!.normalization).toEqual(normalization);
    expect(formatInspect(report).join("\n")).toContain("temp-rename");
    expect(formatInspect(report).join("\n")).toContain("create-delete");
    const before = readFileSync(storage.recordsPath);
    const inspect = Bun.spawn([process.execPath, "index.ts", "--json", "inspect", "fixture"], {
      env: { ...process.env, HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [inspectCode, inspectOut] = await Promise.all([
      inspect.exited,
      new Response(inspect.stdout).text(),
      new Response(inspect.stderr).text(),
    ]);
    expect(inspectCode).toBe(0);
    expect(JSON.parse(inspectOut).tool.capture.segments.at(-1).normalization).toEqual(normalization);
    expect(readFileSync(storage.recordsPath)).toEqual(before);
    await storage.removeRecord(record.id, record.revision);
    const receipts = Bun.spawn([process.execPath, "index.ts", "--json", "inspect", "fixture"], {
      env: { ...process.env, HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [receiptCode, receiptOut] = await Promise.all([
      receipts.exited,
      new Response(receipts.stdout).text(),
      new Response(receipts.stderr).text(),
    ]);
    expect(receiptCode).toBe(0);
    expect(JSON.parse(receiptOut).tool.state).toBe("receipt-only");
    expect(JSON.parse(receiptOut).tool.receipts[0].capture.normalization).toEqual(normalization);
  },
);
