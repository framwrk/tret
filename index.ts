import { IS_DEV, SCRIPT_NAME } from "./src/constants";
import { install } from "./src/commands/install";
import { list } from "./src/commands/list";
import { log } from "./src/lib/utilities";
import { uninstall } from "./src/commands/uninstall";

const args = process.argv.slice(2).filter((arg) => arg !== "--time");

const command = args[0];

// --time is a dev-only flag: timing a compiled binary is meaningless here, so built runs ignore it.
const timed = IS_DEV && process.argv.includes("--time");

const start = Date.now();

switch (command) {
  case "add":
  case "install":
    await install(args[1]);
    break;

  case "unadd":
  case "remove":
  case "uninstall":
    uninstall(args[1], args.includes("--dry-run"));
    break;

  case "show":
  case "list":
    list();
    break;

  default:
    help();
}

if (timed) {
  const time = Date.now() - start;

  log(`\n${time}ms taken`);
}

function help(): void {
  console.log("Name");
  console.log(`\t${SCRIPT_NAME} - Wraps installers and remembers what they added, so you can cleanly remove them later.`);

  console.log("Usage");
  console.log(`\t${SCRIPT_NAME.toLowerCase()} <COMMAND>`);

  console.log("Commands");
  console.log("\tinstall      Run an installer and record everything it adds");
  console.log("\tuninstall    Remove a tool by reversing what its install added");
  console.log("\tlist         Show past installs Tret is tracking");
}
