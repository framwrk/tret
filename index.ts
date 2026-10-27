import { DEFAULT_BACKUP_POLICY, DEFAULT_BACKUP_SIZE_LIMIT_BYTES } from "./src/lib/store";
import { EXIT_USAGE, IS_DEV, SCRIPT_NAME, VERSION } from "./src/constants";
import { extractBackupSizeFlag, extractNameFlag, install, parseObserveFlags } from "./src/commands/install";
import { openRunLog, watchRunLog } from "./src/lib/runlog";
import { checkForUpdate } from "./src/lib/updatecheck";
import { enableJsonMode } from "./src/lib/json-output";
import { fail } from "./src/lib/failure";
import { find } from "./src/commands/find";
import { forget } from "./src/commands/forget";
import { inspect } from "./src/commands/inspect";
import { list } from "./src/commands/list";
import { log } from "./src/lib/utilities";
import { trace } from "./src/commands/trace";
import { unclaim } from "./src/commands/unclaim";
import { uninstall } from "./src/commands/uninstall";
import { update } from "./src/commands/update";

// Everything after `--` belongs to the install script, never to Tret's own flags. `--time` is a
// dev-only flag: timing a compiled binary is meaningless, so built runs ignore it.
const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
const ownArgs = (separator === -1 ? argv : argv.slice(0, separator)).filter((arg) => arg !== "--time");
const scriptArgs = separator === -1 ? [] : argv.slice(separator + 1);

const command = ownArgs[0];

// JSON mode is decided before anything prints, so a human line can never reach stdout in a `--json` run.
if (ownArgs.includes("--json")) enableJsonMode();

const timed = IS_DEV && process.argv.includes("--time");

const start = Date.now();

// `--version` prints the release tag injected at build time and stops there — no update check,
// so a compiled run answers instantly even when offline.
if (ownArgs.includes("--version")) {
  log(`${VERSION}`);
  process.exit(0);
}

// Each run writes its own log under ~/.tret/logs; a failure or crash points the user at that file.
openRunLog(ownArgs);
watchRunLog();

switch (command) {
  case "add":
  case "install": {
    // The pre-`--` line, joined, is the URL or a pasted `curl ... | bash` command. Tret-only flags
    // are removed first so a flag value can never end up inside the URL text.
    const observed = parseObserveFlags(ownArgs.slice(1));
    if ("error" in observed) fail("install-usage", observed.error, EXIT_USAGE);
    const named = extractNameFlag(observed.rest);
    if ("error" in named) fail("install-usage", named.error, EXIT_USAGE);
    const backupSize = extractBackupSizeFlag(named.rest);
    if ("error" in backupSize) fail("install-usage", backupSize.error, EXIT_USAGE);
    const backupsEnabled = ownArgs.includes("--backup");
    // `--backup-size` only means something when backups are on, so using it alone is a usage error
    // rather than a silently ignored flag.
    if (backupSize.sizeLimitBytes !== undefined && !backupsEnabled) {
      fail("install-usage", "--backup-size requires --backup", EXIT_USAGE);
    }
    await install(backupSize.rest.join(" "), ownArgs.includes("--force"), scriptArgs, {
      capture: !ownArgs.includes("--no-capture"),
      // D2: backups are off unless the user opts in; a captured before-image makes restore reachable.
      // `--backup-size` sets the per-file before-image limit for this install; without it the
      // documented default (1 MiB) stays in force.
      backups: backupsEnabled
        ? {
            ...DEFAULT_BACKUP_POLICY,
            enabled: true,
            sizeLimitBytes: backupSize.sizeLimitBytes ?? DEFAULT_BACKUP_POLICY.sizeLimitBytes,
          }
        : undefined,
      // D3: --observe/--observe-exclude scope this one install; an empty scope keeps the defaults.
      observe: observed.scope.include.length > 0 || observed.scope.exclude.length > 0 ? observed.scope : undefined,
      yes: ownArgs.includes("--yes"),
      ...(named.name === undefined ? {} : { name: named.name }),
    });
    break;
  }

  case "unadd":
  case "remove":
  case "uninstall":
    await uninstall(ownArgs[1], ownArgs.includes("--dry-run"), ownArgs.includes("--yes"), ownArgs.includes("--force"));
    break;

  case "show":
  case "list":
    await list();
    break;

  case "find":
    await find(ownArgs[1]);
    break;

  case "forget":
    await forget(ownArgs[1]);
    break;

  case "inspect":
    await inspect(ownArgs[1]);
    break;

  case "trace":
    await trace(ownArgs[1], ownArgs.includes("--yes"));
    break;

  case "unclaim":
    await unclaim(ownArgs[1], ownArgs[2]);
    break;

  case "update":
    // `tret update <tool>` updates one tracked tool by re-running its recorded installer; a bare
    // `tret update` updates Tret itself, so the argument selects which workflow runs.
    await update(ownArgs[1], ownArgs.includes("--yes"));
    break;

  case "help":
  case "-h":
  case "--help":
    help();
    break;

  default:
    help();
}

// Every compiled run checks once a day for a newer release and prints a notice when one
// exists; the check caches its result, so most runs only read it. Dev runs skip the check,
// and `update` replaces the binary itself, so checking right after would be redundant.
if (!IS_DEV && command !== "update") {
  await checkForUpdate();
}

if (timed) {
  const time = Date.now() - start;

  log(`\n${time}ms taken`, true);
}

function help(): void {
  log(`Usage`);
  log(`\t${SCRIPT_NAME.toLowerCase()} [--version] [--json] <command> [arguments]`);
  log("");
  log(`${SCRIPT_NAME} wraps installers and remembers what they added, so you can cleanly remove them later.`);
  log("");
  log(
    `Each install runs inside a bounded capture window. ${SCRIPT_NAME} reports when the window was open and how completely it covered the installer's process tree; it never runs the installed tool itself to discover lazy writes.`,
  );
  log(
    `Linux capture uses unprivileged strace, or the packaged fanotify helper when already root; macOS uses a scoped heuristic snapshot. Capture records changes but does not sandbox the installer or scan for malware.`,
  );
  log("");
  log(`Commands`);
  log(
    `\tinstall <url>     Run an installer inside a bounded capture window and record what it changes; paste the curl | bash line when no URL is given (alias: add)`,
  );
  log(
    `\tuninstall <tool>  Remove a tool by deleting what its install added, stripping its PATH lines, and dropping the record (aliases: remove, unadd)`,
  );
  log(
    `\tunclaim <tool> <path>  Drop one record's claim on a path another record also claims, resolving a shared-owner conflict without --force (changes no files)`,
  );
  log(`\tlist              Show the tools Tret is tracking (alias: show)`);
  log(`\tinspect <tool>    Show what Tret recorded for a tool without changing anything: capture confidence, owned paths, changed files, and what uninstall would do`);
  log(`\tfind <tool>       Find the files and folders an already-installed command owns and record them for uninstall`);
  log(`\ttrace <tool>      Run a tracked tool in a bounded observation window and append what it writes to the record (asks first; --yes when non-interactive)`);
  log(`\tforget <tool>     Stop tracking a tool without touching its files (escape hatch for detect-only leftovers)`);
  log(`\tupdate [tool]     Update Tret to the latest release; with a tool name, re-run that tool's recorded installer`);
  log("");
  log(`A <tool> argument is a display name or a record id; a name shared by several records fails and lists the ids.`);
  log("");
  log(`Options`);
  log(`\t-h, --help    Show this help and exit`);
  log(`\t--version     Print the running version and exit`);
  log(
    `\t--json        Emit one JSON document on stdout instead of human text (install, list, inspect, trace, forget, unclaim, uninstall, update)`,
  );
  log(`\t--force       install: replace an existing tracked install of the URL before reinstalling`);
  log(`\t              uninstall: allow known file/symlink fingerprint mismatches at plan time; bypass shared-owner conflicts`);
  log(`\t              unverified paths and state changes after planning still block removal`);
  log(`\t              delegated-removal overlap always blocks, including with --force`);
  log(`\t--no-capture  install: run the installer without attaching a capture window`);
  log(
    `\t--backup      install: capture before-images of overwritten or deleted files so uninstall can restore them (off by default; eligible regular files only)`,
  );
  log(
    `\t--backup-size <bytes> install: set the per-file before-image size limit for this install (positive integer; requires --backup; default ${DEFAULT_BACKUP_SIZE_LIMIT_BYTES})`,
  );
  log(`\t--observe <path>          install: also observe this absolute path in the install's capture window (repeatable)`);
  log(`\t--observe-exclude <path>  install: drop one of the default capture roots for this install (repeatable)`);
  log(`\t--name <name> install: record the tool under this display name instead of the installed command's basename`);
  log(`\t--dry-run     uninstall: preview what would be removed without deleting anything`);
  log(`\t--yes         install: skip the installer confirmation prompt`);
  log(`\t              uninstall, trace, update <tool>: skip the confirmation prompt`);
  log(`\t              Note: with backups off, mutations/deletions are detect-only and never block uninstall;`);
  log(`\t              a record with nothing actionable left is dropped, or remove it with tret forget <tool>`);
  log(`\t--            install: every flag after this goes to the install script itself`);
  log("");
  log(`Exit codes (for automation; stable)`);
  log(`\t0  the command succeeded`);
  log(`\t1  the command failed`);
  log(`\t2  the command line was wrong`);
  log(`\t3  no tracked install matched the selector`);
  log(`\t4  several tracked installs matched; select one by record id`);
  log(`\t5  the command refused to proceed without explicit consent or force`);
  log("");
  log(`Examples`);
  log(`\t${SCRIPT_NAME.toLowerCase()} install curl -fsSL https://example.com/install.sh | bash`);
  log(`\t${SCRIPT_NAME.toLowerCase()} install https://example.com/install.sh --name opencode -- --skip-browser`);
  log(`\t${SCRIPT_NAME.toLowerCase()} inspect opencode`);
  log(`\t${SCRIPT_NAME.toLowerCase()} inspect opencode --json`);
  log(`\t${SCRIPT_NAME.toLowerCase()} trace opencode`);
  log(`\t${SCRIPT_NAME.toLowerCase()} unclaim opencode ~/.local/bin/opencode`);
  log(`\t${SCRIPT_NAME.toLowerCase()} uninstall opencode --dry-run`);
  log(`\t${SCRIPT_NAME.toLowerCase()} uninstall opencode --yes`);
  log(`\t${SCRIPT_NAME.toLowerCase()} find opencode`);
  log(`\t${SCRIPT_NAME.toLowerCase()} forget opencode`);
  log(`\t${SCRIPT_NAME.toLowerCase()} list`);
  log(`\t${SCRIPT_NAME.toLowerCase()} update opencode`);
  log(`\t${SCRIPT_NAME.toLowerCase()} update`);
}
