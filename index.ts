import { IS_DEV, SCRIPT_NAME } from "./src/constants";
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

switch (command) {
  case "add":
  case "install":
    // The rest of the line, joined: a paste like `tret install curl -fsSL https://... | bash`
    // reaches tret as separate arguments once the shell has taken the pipe.
    await install(args.slice(1).join(" "), args.includes("--force"));
    break;

  case "unadd":
  case "remove":
  case "uninstall":
    uninstall(args[1], args.includes("--dry-run"), args.includes("--yes"));
    break;

  case "show":
  case "list":
    list();
    break;

  case "find":
    find(args[1]);
    break;

  case "update":
    await update();
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
  log("Name");
  log(`\t${SCRIPT_NAME} - Wraps installers and remembers what they added, so you can cleanly remove them later.`);

  log("Usage");
  log(`\t${SCRIPT_NAME.toLowerCase()} <COMMAND>`);

  log("Commands");
  log("\tinstall      Run an installer and record everything it adds (paste the curl | bash line when no URL is given)");
  log("\tuninstall    Remove a tool by reversing what its install added (asks to confirm; --yes skips, --dry-run previews)");
  log("\tlist         Show past installs Tret is tracking");
  log("\tfind         Find the files and folders a command owns and record them so Tret can remove them");
  log("\tupdate       Update Tret to the latest release (skips the download when already up to date)");
}
