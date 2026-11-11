const aliases = new Map([
  ["add", "install"],
  ["remove", "uninstall"],
  ["unadd", "uninstall"],
  ["show", "list"],
]);

const options: Record<string, readonly string[]> = {
  install: ["--yes", "--force", "--backup", "--no-capture"],
  uninstall: ["--yes", "--force", "--dry-run"],
  trace: ["--yes"],
  update: ["--yes"],
  list: [],
  find: [],
  forget: [],
  inspect: [],
  unclaim: [],
  help: [],
};
const installValues = new Set(["--name", "--backup-size", "--observe", "--observe-exclude"]);

/** Validate before dispatch and put selectors before flags for every command handler. */
export function normalizeCliArgs(args: string[], hasScriptSeparator: boolean): { args: string[] } | { error: string } {
  const first = args[0] ?? "help";
  if (first === "--version" || first === "--help" || first === "-h") {
    return args.length <= 1 && !hasScriptSeparator ? { args: [first] } : { error: `${first} takes no arguments` };
  }
  const command = aliases.get(first) ?? first;
  if (!Object.hasOwn(options, command)) return { error: `unknown command: ${first}` };
  if (hasScriptSeparator && command !== "install") return { error: "-- script arguments are only supported by install" };

  const positional: string[] = [];
  const flags: string[] = [];
  const seenValues = new Set<string>();
  let paste = false;
  let help = false;

  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (options[command]!.includes(arg)) {
      flags.push(arg);
      continue;
    }
    if (command === "install" && installValues.has(arg)) {
      const value = args[++index];
      if (value === undefined || value.startsWith("--")) return { error: `${arg} requires a value` };
      if (seenValues.has(arg) && arg !== "--observe" && arg !== "--observe-exclude") {
        return { error: `${arg} may only be provided once` };
      }
      seenValues.add(arg);
      flags.push(arg, value);
      continue;
    }
    // Pasted downloader flags and pipe text are data: install extracts a URL, never executes them.
    // Known Tret options above still work, including --yes before or after the paste.
    if (arg.startsWith("-") && !paste) return { error: `unknown option for ${command}: ${arg}` };
    positional.push(arg);
    if (command === "install" && positional.length === 1 && (arg === "curl" || arg === "wget")) paste = true;
  }

  if (command === "install") {
    if (!paste && positional.length > 1) {
      return { error: "install takes one URL or a pasted curl/wget command; put script arguments after --" };
    }
  } else {
    const maximum = command === "list" || command === "help" ? 0 : command === "unclaim" ? 2 : 1;
    if (positional.length > maximum)
      return { error: `${command} takes at most ${maximum} argument${maximum === 1 ? "" : "s"}` };
  }
  return { args: help ? ["help"] : [command, ...positional, ...flags] };
}
