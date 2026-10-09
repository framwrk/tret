import { IS_DEV, SCRIPT_NAME, VERSION } from "./src/constants";
import { DEFAULT_BACKUP_POLICY } from "./src/lib/store";
import { checkForUpdate } from "./src/lib/updatecheck";
import { find } from "./src/commands/find";
import { install } from "./src/commands/install";
import { list } from "./src/commands/list";
import { log } from "./src/lib/utilities";
import { uninstall } from "./src/commands/uninstall";
import { update } from "./src/commands/update";

const args = process.argv.slice(2).filter((arg) => arg !== "--time");

const command = args[0];

// --time is a dev-only flag: timing a compiled binary is meaningless here, so built runs ignore it.
const timed = IS_DEV && process.argv.includes("--time");

const start = Date.now();

// `--version` prints the release tag injected at build time and stops there — no update check,
// so a compiled run answers instantly even when offline.
if (args.includes("--version")) {
  log(`${VERSION}`);
  process.exit(0);
}

switch (command) {
  case "add":
  case "install": {
    // Everything after `--` goes to the installer script itself (`tret install <URL> -- --skip-browser`).
    // The rest of the pre-`--` line, joined: a paste like `tret install curl -fsSL https://... | bash`
    // reaches tret as separate arguments once the shell has taken the pipe.
    const separator = args.indexOf("--");
    const own = separator === -1 ? args : args.slice(0, separator);
    const scriptArgs = separator === -1 ? [] : args.slice(separator + 1);
    await install(own.slice(1).join(" "), own.includes("--force"), scriptArgs, {
      capture: !own.includes("--no-capture"),
      // D2: backups are off unless the user opts in; a captured before-image makes restore reachable.
      backups: own.includes("--backup") ? { ...DEFAULT_BACKUP_POLICY, enabled: true } : undefined,
    });
    break;
  }

  case "unadd":
  case "remove":
  case "uninstall":
    await uninstall(args[1], args.includes("--dry-run"), args.includes("--yes"), args.includes("--force"));
    break;

  case "show":
  case "list":
    await list();
    break;

  case "find":
    await find(args[1]);
    break;

  case "update":
    await update();
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
  log(`\t${SCRIPT_NAME.toLowerCase()} [--version] <command> [arguments]`);
  log("");
  log(`${SCRIPT_NAME} wraps installers and remembers what they added, so you can cleanly remove them later.`);
  log("");
  log(
    `Each install runs inside a bounded capture window. ${SCRIPT_NAME} reports when the window was open and how completely it covered the installer's process tree; it never runs the installed tool itself to discover lazy writes.`,
  );
  log("");
  log(`Commands`);
  log(
    `\tinstall <url>     Run an installer inside a bounded capture window and record what it changes; paste the curl | bash line when no URL is given (alias: add)`,
  );
  log(
    `\tuninstall <tool>  Remove a tool by deleting what its install added, stripping its PATH lines, and dropping the record (aliases: remove, unadd)`,
  );
  log(`\tlist              Show the tools Tret is tracking (alias: show)`);
  log(`\tfind <tool>       Find the files and folders an already-installed command owns and record them for uninstall`);
  log(`\tupdate            Update Tret to the latest release (skips the download when already up to date)`);
  log("");
  log(`Options`);
  log(`\t-h, --help    Show this help and exit`);
  log(`\t--version     Print the running version and exit`);
  log(`\t--force       install: replace an existing tracked install of the URL before reinstalling`);
  log(`\t              uninstall: remove owned paths even when their fingerprint changed or is shared`);
  log(`\t--no-capture  install: run the installer without attaching a capture window`);
  log(
    `\t--backup      install: capture before-images of overwritten or deleted files so uninstall can restore them (off by default)`,
  );
  log(`\t--dry-run     uninstall: preview what would be removed without deleting anything`);
  log(`\t--yes         uninstall: skip the confirmation prompt`);
  log(`\t--            install: every flag after this goes to the install script itself`);
  log("");
  log(`Examples`);
  log(`\t${SCRIPT_NAME.toLowerCase()} install curl -fsSL https://example.com/install.sh | bash`);
  log(`\t${SCRIPT_NAME.toLowerCase()} install https://example.com/install.sh -- --skip-browser`);
  log(`\t${SCRIPT_NAME.toLowerCase()} uninstall opencode --dry-run`);
  log(`\t${SCRIPT_NAME.toLowerCase()} uninstall opencode --yes`);
  log(`\t${SCRIPT_NAME.toLowerCase()} find opencode`);
  log(`\t${SCRIPT_NAME.toLowerCase()} list`);
  log(`\t${SCRIPT_NAME.toLowerCase()} update`);
}
