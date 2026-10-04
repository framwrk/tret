import { openSync, writeSync } from "node:fs";
import { IS_DEV } from "../constants";

/** The controlling terminal's file descriptor, opened on first use; undefined when there is none. */
let ttyFd: number | undefined;

/** The fd of the controlling terminal for direct terminal output, or undefined when there is none. */
export function ttyOutput(): number | undefined {
  if (ttyFd === undefined) {
    try {
      ttyFd = openSync("/dev/tty", "w");
    } catch {
      // No controlling terminal (agent runs, CI): the caller falls back to stderr.
    }
  }
  return ttyFd;
}

/** Prints a message; with `devOnly` the message prints only when running from source, not a compiled binary. */
export function log(message: string, devOnly = false): void {
  if (!devOnly || IS_DEV) {
    // stdout stays empty whenever it is not a terminal: a pasted `tret install curl ... | bash`
    // pipes tret's stdout into bash, which would execute every printed line. Write to the
    // controlling terminal instead, so the piped paste form doesn't paint every line red as
    // stderr; stderr is only the fallback for runs with no terminal at all.
    if (process.stdout.isTTY) {
      console.log(message);
    } else {
      const fd = ttyOutput();
      if (fd === undefined) {
        console.error(message);
      } else {
        writeSync(fd, `${message}\n`);
      }
    }
  }
}

export function validateUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `not a valid URL: ${url}`;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `install needs an http or https URL: ${url}`;
  }

  const hostname = parsed.hostname.replace(/\.$/, "");
  if (!hostname.includes(".")) {
    return `URL needs a domain with a TLD: ${url}`;
  }
}

/** Returns the first http or https URL in the text, or undefined when the text has none. */
export function extractUrl(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s"'`|]+/)?.[0];
}

/** Reads one line of stdin, for pasting an install command at a prompt. */
export async function readLine(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      const newline = text.indexOf("\n");
      if (newline !== -1) return text.slice(0, newline);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

/** Fetches the full script at the URL, or undefined when it does not serve a raw script. */
export async function fetchScript(url: string): Promise<string | undefined> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || contentType.startsWith("text/html")) {
    return undefined;
  }

  const text = await response.text();
  return text.startsWith("<") || text.includes("\0") ? undefined : text;
}
