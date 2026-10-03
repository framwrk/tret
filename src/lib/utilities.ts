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

export async function isScript(url: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    return false;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || contentType.startsWith("text/html")) {
    return false;
  }

  const reader = response.body?.getReader();
  if (!reader) return false;

  const chunk = await reader.read();
  await reader.cancel();
  const text = new TextDecoder().decode(chunk.value ?? new Uint8Array());
  return !text.startsWith("<") && !text.includes("\0");
}
