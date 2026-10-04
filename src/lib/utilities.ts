import { IS_DEV } from "../constants";

/** Prints a message; with `devOnly` the message prints only when running from source, not a compiled binary. */
export function log(message: string, devOnly = false): void {
  if (!devOnly || IS_DEV) {
    // stderr, not stdout, when piped: a pasted `tret install curl ... | bash` sends tret's stdout
    // to bash, which would execute every printed line. Empty stdout leaves bash nothing to run.
    // Interactive runs print to stdout so the terminal doesn't paint every log line red as stderr.
    const print = process.stdout.isTTY ? console.log : console.error;
    print(message);
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
