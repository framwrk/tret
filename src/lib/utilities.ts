export function log(message: string): void {
  console.log(message);
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
