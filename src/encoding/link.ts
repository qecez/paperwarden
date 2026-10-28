import { PaperError } from "../crypto/errors";
import { BACKUP_BYTES } from "../format/constants";
import { parseEnvelope } from "../format/envelope";
import { decodeTransport } from "./transport";

export const READER_URL = "https://paperwarden.com/";
export const LINK_FRAGMENT_MARKER = "#PWN1:";
export const RADIX43_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$*+-./:";
export const RADIX43_CHARACTERS = 4219;
// A byte-mode prefix of 50 characters plus 4,219 alphanumeric characters
// consumes 23,642 of the 23,648 data bits available in version 40/L.
export const MAX_LINK_PREFIX_CHARACTERS = 50;
const BLOCK_BYTES = 21;
const BLOCK_CHARACTERS = 31;
const FULL_BLOCKS = 136;
const LAST_BLOCK_BYTES = 2;
const LAST_BLOCK_CHARACTERS = 3;
const FRAGMENT_CHARACTERS = LINK_FRAGMENT_MARKER.length + RADIX43_CHARACTERS;

/** Fixed-width big-endian radix43; this is a transport encoding, not encryption. */
export function encodeRadix43(bytes: Uint8Array): string {
  if (bytes.length !== BACKUP_BYTES) throw new PaperError("format");
  let text = "";
  for (let block = 0; block <= FULL_BLOCKS; block++) {
    const size = block < FULL_BLOCKS ? BLOCK_BYTES : LAST_BLOCK_BYTES;
    const width =
      block < FULL_BLOCKS ? BLOCK_CHARACTERS : LAST_BLOCK_CHARACTERS;
    let value = 0n;
    for (let i = 0; i < size; i++)
      value = (value << 8n) | BigInt(bytes[block * BLOCK_BYTES + i]);
    let digits = "";
    for (let i = 0; i < width; i++) {
      digits = RADIX43_ALPHABET[Number(value % 43n)] + digits;
      value /= 43n;
    }
    text += digits;
  }
  return text;
}

export function decodeRadix43(text: string): Uint8Array {
  if (text.length !== RADIX43_CHARACTERS) throw new PaperError("format");
  const bytes = new Uint8Array(BACKUP_BYTES);
  for (let block = 0; block <= FULL_BLOCKS; block++) {
    const size = block < FULL_BLOCKS ? BLOCK_BYTES : LAST_BLOCK_BYTES;
    const width =
      block < FULL_BLOCKS ? BLOCK_CHARACTERS : LAST_BLOCK_CHARACTERS;
    let value = 0n;
    for (let i = 0; i < width; i++) {
      const digit = RADIX43_ALPHABET.indexOf(
        text[block * BLOCK_CHARACTERS + i],
      );
      if (digit < 0) throw new PaperError("format");
      value = value * 43n + BigInt(digit);
    }
    // Fixed widths have unused values. Reject aliases instead of truncating.
    if (value >= 1n << BigInt(size * 8)) throw new PaperError("format");
    for (let i = size - 1; i >= 0; i--) {
      bytes[block * BLOCK_BYTES + i] = Number(value & 255n);
      value >>= 8n;
    }
  }
  return bytes;
}

function canonicalBaseUrl(baseUrl: string): string {
  // Reject characters the URL parser would silently strip, escape or reinterpret.
  if (
    baseUrl.length > MAX_LINK_PREFIX_CHARACTERS ||
    !/^https:\/\/[^/]+(?:\/|$)/i.test(baseUrl) ||
    /^https:\/\/[^/]*@/i.test(baseUrl) ||
    !/^[\x21-\x7e]+$/.test(baseUrl) ||
    /[%\\?#]/.test(baseUrl)
  )
    throw new PaperError("format");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new PaperError("format");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /[%\\?#]/.test(url.href) ||
    url.href.length + LINK_FRAGMENT_MARKER.length > MAX_LINK_PREFIX_CHARACTERS
  )
    throw new PaperError("format");
  return url.href;
}

export function encodeLink(bytes: Uint8Array, baseUrl = READER_URL): string {
  parseEnvelope(bytes);
  return (
    canonicalBaseUrl(baseUrl) + LINK_FRAGMENT_MARKER + encodeRadix43(bytes)
  );
}

export function decodeLinkFragment(fragment: string): Uint8Array {
  if (fragment.length !== FRAGMENT_CHARACTERS) throw new PaperError("format");
  if (!fragment.startsWith(LINK_FRAGMENT_MARKER)) {
    throw new PaperError(/^#PWN\d+:/.test(fragment) ? "version" : "format");
  }
  const bytes = decodeRadix43(fragment.slice(LINK_FRAGMENT_MARKER.length));
  parseEnvelope(bytes);
  return bytes;
}

/** Extract data only: the host is not an identity claim and is never contacted. */
export function decodeLink(text: string): Uint8Array {
  if (text.length > MAX_LINK_PREFIX_CHARACTERS + RADIX43_CHARACTERS)
    throw new PaperError("format");
  const hash = text.indexOf("#");
  if (hash < 0) throw new PaperError("format");
  const base = text.slice(0, hash);
  if (canonicalBaseUrl(base) !== base) throw new PaperError("format");
  return decodeLinkFragment(text.slice(hash));
}

/** Shared by camera, image, and pasted QR payload recovery. */
export function decodeQrPayload(text: string): Uint8Array {
  return text.startsWith("PWN:") ? decodeTransport(text) : decodeLink(text);
}
