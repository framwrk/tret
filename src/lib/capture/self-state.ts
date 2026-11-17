import type { Journal, JournalEvent } from "./events";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** Built once per window, including the existing HOME alias, rather than once per scanned node. */
export function privateStateFilter(home = process.env.HOME): (path: string) => boolean {
  const roots = new Set<string>();
  if (home) {
    roots.add(resolve(home, ".tret"));
    try {
      roots.add(resolve(realpathSync(home), ".tret"));
    } catch {
      /* Missing HOME still has its lexical boundary. */
    }
  }
  return (path) =>
    /(?:^|\/)\.tret-stage-[0-9a-f-]{36}(?:\/|$)/.test(path) ||
    [...roots].some((root) => path === root || path.startsWith(root + "/"));
}

export function excludePrivateState(journal: Journal, home = process.env.HOME, bookkeepingPid?: number): Journal {
  const excluded = privateStateFilter(home);
  const events: JournalEvent[] = journal.events.flatMap((event): JournalEvent[] => {
    if (event.type !== "rename") return excluded(event.path) ? [] : [event];
    const from = excluded(event.from), to = excluded(event.to);
    if ((event.inScope === "from" && from) || (event.inScope === "to" && to)) return [];
    if (from && to) return [];
    if (!from && !to) return [event];
    return [{ ...event, semantics: "uncertain", inScope: from ? "to" : "from",
      ...(from ? { before: undefined, sourceAfter: undefined } : { destinationBefore: undefined, after: undefined }) }];
  });
  if (events.every((event, index) => event === journal.events[index]) && events.length === journal.events.length) return journal;
  const kept = new Set(events);
  if (
    bookkeepingPid !== undefined &&
    journal.events.filter((event) => !kept.has(event)).every((event) => event.pid === bookkeepingPid)
  )
    return { ...journal, events };
  return {
    ...journal,
    events,
    completeness: journal.completeness === "heuristic" ? "heuristic" : "partial",
    partialReason: [
      journal.partialReason,
      "private Tret state events excluded; changes to this state are not installation payload",
    ]
      .filter(Boolean)
      .join("; "),
  };
}
