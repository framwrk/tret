/** Positive fixtures explicitly permit weaker observation; refusal tests use their own raw runner. */
export function withWeakerCaptureConsent(args: string[]): string[] {
  const index = args.findIndex((arg) => !arg.startsWith("--"));
  if (index === -1 || !["install", "add", "trace", "update"].includes(args[index]!) || args.includes("--allow-weaker-capture"))
    return args;
  if (args[index] === "update" && !args.slice(index + 1).some((arg) => !arg.startsWith("--"))) return args;
  return [...args.slice(0, index + 1), "--allow-weaker-capture", ...args.slice(index + 1)];
}
