import { OperationLog, OperationRecoveryRequiredError } from "./operation-log";
import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withOperationLease } from "./operation-lease";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tret-operation-log-"));
  roots.push(root);
  return root;
}

test("intent, stages and blob pins survive a new lease; unfinished work blocks new mutations", async () => {
  const root = fixture();
  const log = new OperationLog(root);
  expect(log.list()).toEqual([]);
  expect(() => log.begin("install")).toThrow("require the store operation lease");
  let id = "";
  await withOperationLease(root, async () => {
    let operation = log.begin("install");
    id = operation.id;
    operation = log.checkpoint(operation, { pins: ["a".repeat(64)], stage: "running", unknownSince: new Date().toISOString() });
    expect(log.pinnedBlobs()).toEqual(["a".repeat(64)]);
    expect(lstatSync(join(log.directory, `${id}.json`)).mode & 0o777).toBe(0o600);
    expect(() => log.checkpoint(operation, { stage: "prepared" })).toThrow("invalid operation stage");
  });
  await withOperationLease(root, async () => {
    expect(() => log.begin("uninstall")).toThrow(OperationRecoveryRequiredError);
    expect(log.list()[0]?.stage).toBe("running");
    const operation = log.list()[0]!;
    expect(() => log.checkpoint(operation, { stage: "captured" })).toThrow("different lease");
    log.discard(id);
    expect(log.pinnedBlobs()).toEqual([]);
    log.begin("metadata");
  });
});

test("stale checkpoints and completed-operation replay fail without replacing evidence", async () => {
  const root = fixture();
  const log = new OperationLog(root);
  await withOperationLease(root, async () => {
    const original = log.begin("install");
    let next = log.checkpoint(original, { stage: "running" });
    expect(() => log.checkpoint(original, { stage: "partial" })).toThrow("checkpoint changed");
    next = log.checkpoint(next, { stage: "captured" });
    next = log.checkpoint(next, { stage: "completed" });
    const bytes = readFileSync(join(log.directory, `${next.id}.json`));
    expect(() => log.checkpoint(next, { stage: "running" })).toThrow("cannot be resumed");
    expect(readFileSync(join(log.directory, `${next.id}.json`))).toEqual(bytes);
    log.begin("metadata");
  });
});

test("corrupt and future operation files prevent mutation and collection", async () => {
  const root = fixture();
  const log = new OperationLog(root);
  mkdirSync(log.directory);
  const path = join(log.directory, "01234567-0123-0123-0123-012345678901.json");
  writeFileSync(path, '{"version":999}');
  expect(() => log.pinnedBlobs()).toThrow("invalid operation evidence");
  await withOperationLease(root, async () => {
    expect(() => log.begin("install")).toThrow();
    expect(readFileSync(path, "utf8")).toBe('{"version":999}');
  });
});

test.each(["observe", "collision"])("initial manifest publication is atomic and exclusive: %s", async (phase) => {
  const root = fixture();
  const probe = join(root, "publish-probe.ts");
  writeFileSync(
    probe,
    `
    import * as fs from 'node:fs';
    import { mock } from 'bun:test';
    const real={...fs};
    const root=process.argv[2];
    const paths=new Map();
    let log, observations=0, errors=0;
    mock.module('node:fs',()=>({...real,
      openSync:(...args)=>{const fd=real.openSync(...args);paths.set(fd,args[0]);return fd;},
      closeSync:(fd)=>{paths.delete(fd);return real.closeSync(fd);},
      writeSync:(fd,...args)=>{
        if(log && String(paths.get(fd)).startsWith(root+'/operations/')) {
          observations++;
          try{log.list();}catch{errors++;}
        }
        return real.writeSync(fd,...args);
      }
    }));
    if(${JSON.stringify(phase)}==='collision') {
      const crypto=await import('node:crypto');
      mock.module('node:crypto',()=>({...crypto,randomUUID:()=> '11111111-1111-1111-1111-111111111111'}));
    }
    const {OperationLog}=await import(${JSON.stringify(join(import.meta.dir, "operation-log.ts"))});
    const {withOperationLease}=await import(${JSON.stringify(join(import.meta.dir, "operation-lease.ts"))});
    log=new OperationLog(root);
    await withOperationLease(root,async()=>{
      if(${JSON.stringify(phase)}==='observe') {
        log.begin('install');
        if(!observations||errors)throw new Error('reader observed an incomplete initial manifest: '+errors);
      } else {
        const op=log.recordEvidenceDiscard('original',[]);
        const path=root+'/operations/'+op.id+'.json';
        const before=real.readFileSync(path);
        let refused=false;try{log.recordEvidenceDiscard('replacement',[]);}catch{refused=true;}
        if(!refused||!before.equals(real.readFileSync(path)))throw new Error('existing manifest was overwritten');
        if(real.readdirSync(root+'/operations').some(name=>name.endsWith('.tmp')))throw new Error('failed publication stranded staging');
      }
    });
  `,
  );
  const child = Bun.spawn([process.execPath, probe, root], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, out, err }).toEqual({ code: 0, out: "", err: "" });
});
