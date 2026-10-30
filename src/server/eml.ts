/**
 * Just enough RFC 5322 / MIME to take a supplier's .eml file into the inbox: the From and Subject headers and the
 * plain-text body. HTML-only mail and attachments are refused rather than rendered; the reader only ever sees text.
 */

export interface ParsedEml {
  from: string | null;
  subject: string | null;
  body: string;
}

/** The message has no text/plain part, so there is nothing safe to read. */
export class EmlNotPlainText extends Error {
  constructor() {
    super("the message has no plain-text part; paste the text instead");
    this.name = "EmlNotPlainText";
  }
}

const HEADER_LINE = /^[A-Za-z][A-Za-z0-9-]*:[ \t]?/;
const KNOWN_HEADERS = /^(from|subject|to|date|received|mime-version|content-type|message-id|return-path):/im;

function splitHeaders(raw: string): { headers: Map<string, string>; body: string } | null {
  const text = raw.replace(/\r\n/g, "\n");
  const end = text.indexOf("\n\n");
  const head = end === -1 ? text : text.slice(0, end);
  const lines = head.split("\n");
  if (!HEADER_LINE.test(lines[0] ?? "")) return null;
  const headers = new Map<string, string>();
  let current: string | null = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) {
      headers.set(current, `${headers.get(current)} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0 || !HEADER_LINE.test(line)) return null;
    current = line.slice(0, colon).toLowerCase();
    if (!headers.has(current)) headers.set(current, line.slice(colon + 1).trim());
  }
  return { headers, body: end === -1 ? "" : text.slice(end + 2) };
}

function param(header: string, name: string): string | null {
  return header.match(new RegExp(`${name}\\s*=\\s*(?:"([^"]+)"|([^;\\s]+))`, "i"))?.slice(1).find(Boolean) ?? null;
}

function decodeBytes(bytes: Uint8Array, charset: string | null): string {
  try {
    // The label comes from the message; an unknown one throws and falls back to UTF-8.
    const label = (charset ?? "utf-8") as ConstructorParameters<typeof TextDecoder>[0];
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function decodeQuotedPrintable(text: string): Uint8Array {
  const joined = text.replace(/=\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const hex = joined.slice(i + 1, i + 3);
    if (joined[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...new TextEncoder().encode(joined[i]!));
    }
  }
  return Uint8Array.from(bytes);
}

/** RFC 2047 encoded words in headers, e.g. `=?utf-8?Q?Re=3A_invoice?=`. */
function decodeHeader(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset: string, encoding: string, data: string) => {
    const bytes = encoding.toUpperCase() === "B" ? Buffer.from(data, "base64") : decodeQuotedPrintable(data.replace(/_/g, " "));
    return decodeBytes(bytes, charset);
  });
}

function plainText(headers: Map<string, string>, body: string): string | null {
  const type = headers.get("content-type") ?? "text/plain";
  const mime = type.split(";")[0]!.trim().toLowerCase();
  if (mime.startsWith("multipart/")) {
    const boundary = param(type, "boundary");
    if (!boundary) return null;
    for (const chunk of body.split(`--${boundary}`).slice(1)) {
      if (chunk.startsWith("--")) break;
      const part = splitHeaders(chunk.replace(/^\n/, ""));
      const text = part ? plainText(part.headers, part.body) : null;
      if (text !== null) return text;
    }
    return null;
  }
  if (mime !== "text/plain") return null;
  const encoding = (headers.get("content-transfer-encoding") ?? "").toLowerCase();
  const charset = param(type, "charset");
  if (encoding === "base64") return decodeBytes(Buffer.from(body.replace(/\s+/g, ""), "base64"), charset);
  if (encoding === "quoted-printable") return decodeBytes(decodeQuotedPrintable(body), charset);
  return body;
}

/** The address inside `"Name" <addr>`, or the header as written. */
function address(from: string): string {
  return from.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] ?? from.trim();
}

/**
 * Parses `raw` as an .eml file. Null when it does not look like one (plain pasted text), so the caller can file it as
 * written. Throws EmlNotPlainText for mail whose only body is HTML or an attachment.
 */
export function parseEml(raw: string): ParsedEml | null {
  if (!KNOWN_HEADERS.test(raw.slice(0, 4_000))) return null;
  const parsed = splitHeaders(raw);
  if (!parsed) return null;
  const { headers, body } = parsed;
  if (!headers.has("from") && !headers.has("subject")) return null;
  const text = plainText(headers, body);
  if (text === null) throw new EmlNotPlainText();
  const from = headers.get("from");
  const subject = headers.get("subject");
  return {
    from: from ? address(decodeHeader(from)) : null,
    subject: subject ? decodeHeader(subject) : null,
    body: text.trim(),
  };
}
