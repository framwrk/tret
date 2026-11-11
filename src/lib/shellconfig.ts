import type { AbsolutePath, RecordV3 } from "../types";
import { dirname, join, resolve } from "node:path";
import type { Platform } from "./platform";
import { currentPlatform } from "./platform";

/** Final-state names, markers and hashes cannot prove an installer added a shell line. */
export function unverifiedShellEdits(
  record: RecordV3,
  platform: Platform = currentPlatform(),
  home: AbsolutePath | undefined = Bun.env.HOME,
): AbsolutePath[] {
  if (!home) throw new Error("HOME is not set");
  const key = (path: string): string => {
    const absolute = resolve(path);
    return record.caseSensitive ? absolute : absolute.toLowerCase();
  };
  const paths = [...record.mutated, ...record.deleted]
    .filter((entry) => entry.beforeBlob === undefined)
    .filter((entry) =>
      platform.shellConfigs.some((config) => {
        const path = config.scope === "home" ? join(home, config.path) : config.path;
        return config.kind === "file" ? key(entry.path) === key(path) : key(dirname(entry.path)) === key(path);
      }),
    )
    .map((entry) => entry.path);
  return [...new Set(paths)].sort();
}
