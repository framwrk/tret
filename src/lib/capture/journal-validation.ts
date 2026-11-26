import type { JournalEvent } from "./events";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const path = (value: unknown) => typeof value === "string" && value.startsWith("/") && !value.includes("\0");
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const mode = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0o177777;
function node(value: unknown, optional = false, nullable = false): boolean {
  if (value === undefined) return optional;
  if (value === null) return nullable;
  if (!object(value)) return false;
  if (value.kind === "unknown") return Object.keys(value).length === 1;
  if (value.mode !== undefined && !mode(value.mode)) return false;
  if (value.kind === "directory") return true;
  if (value.kind === "symlink") return typeof value.target === "string" && !value.target.includes("\0");
  return (
    value.kind === "file" &&
    (value.hash === undefined || (typeof value.hash === "string" && /^[a-f0-9]{64}$/.test(value.hash))) &&
    (value.size === undefined || (Number.isSafeInteger(value.size) && Number(value.size) >= 0)) &&
    (value.mtimeMs === undefined || number(value.mtimeMs))
  );
}

/** New namespace semantics require logical v2; v1 cannot silently reinterpret them as moves. */
export function validJournalEvents(events: unknown[], version: 1 | 2): events is JournalEvent[] {
  return events.every((event) => {
    if (!object(event)) return false;
    if (version === 1)
      return (
        event.type !== "observation" &&
        event.semantics === undefined &&
        event.inScope === undefined &&
        event.sourceAfter === undefined &&
        event.after !== null &&
        ![event.before, event.after, event.destinationBefore].some((value) => object(value) && value.kind === "unknown")
      );
    if (
      !Number.isSafeInteger(event.seq) ||
      Number(event.seq) < 0 ||
      !number(event.at) ||
      (event.pid !== undefined && (!Number.isSafeInteger(event.pid) || Number(event.pid) < 0))
    )
      return false;
    if (event.type === "rename")
      return (
        path(event.from) &&
        path(event.to) &&
        (event.semantics === undefined || event.semantics === "exchange" || event.semantics === "uncertain") &&
        (event.inScope === undefined ||
          (event.semantics === "uncertain" && (event.inScope === "from" || event.inScope === "to"))) &&
        (event.sourceAfter === undefined || event.semantics !== undefined) &&
        node(event.before, true) &&
        node(event.destinationBefore, true, true) &&
        node(event.after, true, true) &&
        node(event.sourceAfter, true, true)
      );
    if (event.semantics !== undefined || event.inScope !== undefined || event.sourceAfter !== undefined || !path(event.path))
      return false;
    switch (event.type) {
      case "observation":
        return ["rename-descendant", "removal-reoccupied", "baseline-unknown"].includes(String(event.reason))
          && node(event.before, true) && node(event.after, false, true);
      case "create":
        return node(event.after);
      case "write":
        return (
          node(event.before, true) &&
          node(event.after) &&
          object(event.after) &&
          event.after.kind === "file" &&
          (event.before === undefined || (object(event.before) && event.before.kind === "file"))
        );
      case "unlink":
        return node(event.before);
      case "mkdir":
        return node(event.after) && object(event.after) && event.after.kind === "directory";
      case "rmdir":
        return node(event.before) && object(event.before) && event.before.kind === "directory";
      case "symlink":
        return (
          typeof event.target === "string" &&
          !event.target.includes("\0") &&
          node(event.after) &&
          object(event.after) &&
          event.after.kind === "symlink"
        );
      case "chmod":
        return (
          object(event.after) &&
          mode(event.after.mode) &&
          (event.before === undefined || (object(event.before) && (event.before.mode === undefined || mode(event.before.mode))))
        );
      default:
        return false;
    }
  });
}
