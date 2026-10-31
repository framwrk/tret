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
import { info, log } from "./src/lib/utilities";
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

// `--version` prints the release tag injected at build time and stops there — no logging or
// update check, so a compiled run answers instantly even when offline or stdout is piped.
if (ownArgs.includes("--version")) {
  info(`${VERSION}`);
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
  info(`Usage`);
  info(`\t${SCRIPT_NAME.toLowerCase()} [--version] [--json] <command> [arguments]`);
  info("");
  info(`${SCRIPT_NAME} wraps installers and remembers what they added, so you can cleanly remove them later.`);
  info("");
  info(
    `Each install runs inside a bounded capture window. ${SCRIPT_NAME} reports when the window was open and how completely it covered the installer's process tree; it never runs the installed tool itself to discover lazy writes.`,
  );
  info(
    `Linux capture uses unprivileged strace, or the packaged fanotify helper when already root; macOS uses a scoped heuristic snapshot. Capture records changes but does not sandbox the installer or scan for malware.`,
  );
  info("");
  info(`Commands`);
  info(
    `\tinstall <url>     Run an installer inside a bounded capture window and record what it changes; paste the curl | bash line when no URL is given (alias: add)`,
  );
  info(
    `\tuninstall <tool>  Remove a tool by deleting what its install added, stripping its PATH lines, and dropping the record (aliases: remove, unadd)`,
  );
  info(
    `\tunclaim <tool> <path>  Drop one record's claim on a path another record also claims, resolving a shared-owner conflict without --force (changes no files)`,
  );
  info(`\tlist              Show the tools Tret is tracking (alias: show)`);
  info(`\tinspect <tool>    Show what Tret recorded for a tool without changing anything: capture confidence, owned paths, changed files, and what uninstall would do`);
  info(`\tfind <tool>       Find the files and folders an already-installed command owns and record them for uninstall`);
  info(`\ttrace <tool>      Run a tracked tool in a bounded observation window and append what it writes to the record (asks first; --yes when non-interactive)`);
  info(`\tforget <tool>     Stop tracking a tool without touching its files (escape hatch for detect-only leftovers)`);
  info(`\tupdate [tool]     Update Tret to the latest release; with a tool name, re-run that tool's recorded installer`);
  info("");
  info(`A <tool> argument is a display name or a record id; a name shared by several records fails and lists the ids.`);
  info("");
  info(`--version, help, and the human list table print to stdout even when it is piped.`);
  info(`Command progress, prompts, and installer output stay off a piped stdout, so the pasted install command still pipes cleanly to bash.`);
  info("");
  info(`Options`);
  info(`\t-h, --help    Show this help and exit`);
  info(`\t--version     Print the running version and exit`);
  info(
    `\t--json        Emit one JSON document on stdout instead of human text (install, list, inspect, trace, forget, unclaim, uninstall, update)`,
  );
  info(`\t              Human text and installer output go to the terminal or stderr, so a piped run stays valid JSON`);
  info(`\t--force       install: replace an existing tracked install of the URL before reinstalling`);
  info(`\t              uninstall: allow known file/symlink fingerprint mismatches at plan time; bypass shared-owner conflicts`);
  info(`\t              unverified paths and state changes after planning still block removal`);
  info(`\t              delegated-removal overlap always blocks, including with --force`);
  info(`\t--no-capture  install: run the installer without attaching a capture window`);
  info(
    `\t--backup      install: capture before-images of overwritten or deleted files so uninstall can restore them (off by default; eligible regular files only)`,
  );
  info(
    `\t--backup-size <bytes> install: set the per-file before-image size limit for this install (positive integer; requires --backup; default ${DEFAULT_BACKUP_SIZE_LIMIT_BYTES} bytes, 1 MiB)`,
  );
  info(`\t--observe <path>          install: also observe this absolute path in the install's capture window (repeatable)`);
  info(`\t--observe-exclude <path>  install: drop one of the default capture roots for this install (repeatable)`);
  info(`\t--name <name> install: record the tool under this display name instead of the installed command's basename`);
  info(`\t--dry-run     uninstall: preview what would be removed without deleting anything`);
  info(`\t--yes         install: skip the installer confirmation prompt`);
  info(`\t              uninstall, trace, update <tool>: skip the confirmation prompt`);
  info(`\t              uninstall and trace require --yes in JSON mode; install and update <tool> never prompt there`);
  info(`\t              Note: with backups off, mutations/deletions are detect-only and never block uninstall;`);
  info(`\t              a record with nothing actionable left is dropped, or remove it with tret forget <tool>`);
  info(`\t--            install: every flag after this goes to the install script itself`);
  info("");
  info(`Exit codes (for automation; stable)`);
  info(`\t0  the command succeeded`);
  info(`\t1  the command failed`);
  info(`\t2  the command line was wrong`);
  info(`\t3  no tracked install matched the selector`);
  info(`\t4  several tracked installs matched; select one by record id`);
  info(`\t5  the command refused to proceed without explicit consent or force`);
  info("");
  info(`Examples`);
  info(`\t${SCRIPT_NAME.toLowerCase()} install curl -fsSL https://example.com/install.sh | bash`);
  info(`\t${SCRIPT_NAME.toLowerCase()} install https://example.com/install.sh --name opencode -- --skip-browser`);
  info(`\t${SCRIPT_NAME.toLowerCase()} install https://example.com/install.sh --backup --backup-size 524288`);
  info(`\t${SCRIPT_NAME.toLowerCase()} install https://example.com/install.sh --json`);
  info(`\t${SCRIPT_NAME.toLowerCase()} inspect opencode`);
  info(`\t${SCRIPT_NAME.toLowerCase()} inspect opencode --json`);
  info(`\t${SCRIPT_NAME.toLowerCase()} trace opencode`);
  info(`\t${SCRIPT_NAME.toLowerCase()} trace opencode --yes --json`);
  info(`\t${SCRIPT_NAME.toLowerCase()} unclaim opencode ~/.local/bin/opencode`);
  info(`\t${SCRIPT_NAME.toLowerCase()} uninstall opencode --dry-run`);
  info(`\t${SCRIPT_NAME.toLowerCase()} uninstall opencode --yes`);
  info(`\t${SCRIPT_NAME.toLowerCase()} find opencode`);
  info(`\t${SCRIPT_NAME.toLowerCase()} forget opencode`);
  info(`\t${SCRIPT_NAME.toLowerCase()} list`);
  info(`\t${SCRIPT_NAME.toLowerCase()} update opencode`);
  info(`\t${SCRIPT_NAME.toLowerCase()} update`);
}
