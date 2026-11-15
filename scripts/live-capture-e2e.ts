/** Native compiled-artifact checkpoint/termination gate; invoked only by privileged Linux CI. */
import { currentPlatform, installObservationRoots } from "../src/lib/platform";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FileStorage } from "../src/lib/store";
import { OperationLockedError } from "../src/lib/operation-lease";
import { tmpdir } from "node:os";

if (process.platform !== "linux" || process.getuid?.() !== 0)
  throw new Error("live-capture-e2e requires the isolated Linux root CI fixture");
const binary = resolve(process.argv[2]!);
const home = mkdtempSync(join(tmpdir(), "tret-live-artifact-"));
const scope = join(home, "scope");
const scratch = join(home, "tmp");
mkdirSync(scope);
mkdirSync(scratch);
mkdirSync(join(home, ".tret"), { mode: 0o700 });
writeFileSync(
  join(home, ".tret/update-check.json"),
  JSON.stringify({ checkedAt: new Date().toISOString(), tag: "v0.0.0", outdated: false }),
  { mode: 0o600 },
);
const storage = new FileStorage({ homeDir: home });
const env = { ...process.env, HOME: home, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
let requests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => {
    requests++;
    return new Response(
      '#!/bin/sh\nset -eC\nprintf x >> "$HOME/executed"\nprintf "#!/bin/sh\\nexit 0\\n" > "$HOME/scope/tool"\nchmod +x "$HOME/scope/tool"\nwhile [ ! -f "$HOME/release" ]; do sleep 0.02; done\n',
    );
  },
});
const excluded = installObservationRoots(currentPlatform(), { home }).flatMap((root) => ["--observe-exclude", root]);
const child = Bun.spawn(
  [binary, "--json", "install", `http://127.0.0.1:${server.port}/fixture.sh`, "--yes", ...excluded, "--observe", scope],
  { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
);
const stdout = new Response(child.stdout).text(),
  stderr = new Response(child.stderr).text();
const release = () => writeFileSync(join(home, "release"), "go");
try {
  const deadline = performance.now() + 15_000;
  for (;;) {
    const prefix = storage.operations.list()[0]?.capture;
    if (prefix?.events.some((event) => "path" in event && event.path === join(scope, "tool"))) break;
    if (performance.now() > deadline || child.exitCode !== null)
      throw new Error("native strace did not persist the live fixture prefix");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const operation = storage.operations.list()[0]!;
  if (
    operation.stage !== "running" ||
    operation.capture?.backend !== "linux-strace" ||
    !operation.unknownSince ||
    !operation.checkpointAt ||
    operation.capture.completeness !== "partial"
  )
    throw new Error("native live checkpoint claimed a closed or complete window");
  child.kill("SIGKILL");
  if ((await child.exited) !== 137) throw new Error("fixture process did not terminate by SIGKILL");
  let entered = false;
  try {
    await new FileStorage({ homeDir: home, lockTimeoutMs: 20 }).withOperation(async () => {
      entered = true;
    }, true);
  } catch (error) {
    if (!(error instanceof OperationLockedError)) throw error;
  }
  if (entered) throw new Error("foreground work lost its operation lease after parent death");
  release();
  await Promise.all([stdout, stderr]);
  const recovered = Bun.spawn([binary, "--json", "recover", operation.id, "--resume", "--yes"], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    recovered.exited,
    new Response(recovered.stdout).text(),
    new Response(recovered.stderr).text(),
  ]);
  if (code !== 0 || JSON.parse(out).operation.stage !== "partial")
    throw new Error(`compiled live-prefix recovery failed: ${code}: ${err}`);
  const record = (await storage.loadRecords())[0]!;
  if (
    !record.owned.some((effect) => effect.path === join(scope, "tool")) ||
    record.capture.completeness !== "partial" ||
    record.evidence?.some((effect) => effect.authority !== "none") ||
    !existsSync(join(scope, "tool")) ||
    readFileSync(join(home, "executed"), "utf8") !== "x" ||
    requests !== 1
  )
    throw new Error("live-prefix recovery lost effects, granted authority, changed targets or reran the installer");
  console.log("live-capture-e2e: compiled linux-strace prefix, SIGKILL lease, partial recovery and no replay passed");
} finally {
  release();
  child.kill();
  await Promise.all([child.exited, stdout, stderr]);
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
}
