import { PaperError } from "../crypto/errors";
import { parseEnvelope } from "../format/envelope";
import { decodeTransport } from "./transport";
import { decodeRadix42, encodeRadix42, RADIX42_CHARACTERS } from "./radix42";

export const READER_URL = "https://paperwarden.com/";
export const LINK_FRAGMENT_MARKER = "#PWN1:";
// End with a letter so link detectors do not strip trailing punctuation.
export const LINK_SUFFIX = "A";
export const LINK_PAYLOAD_CHARACTERS = RADIX42_CHARACTERS + LINK_SUFFIX.length;
// A 35-byte prefix plus 4,242 alphanumeric characters consumes exactly
// the 23,648 data bits available in version 40/L. The default prefix is 30.
export const MAX_LINK_PREFIX_CHARACTERS = 35;
const MAX_LINK_CHARACTERS =
  MAX_LINK_PREFIX_CHARACTERS + LINK_PAYLOAD_CHARACTERS;

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
    canonicalBaseUrl(baseUrl) +
    LINK_FRAGMENT_MARKER +
    encodeRadix42(bytes) +
    LINK_SUFFIX
  );
}

export function decodeLinkFragment(fragment: string): Uint8Array {
  if (!fragment.startsWith(LINK_FRAGMENT_MARKER))
    throw new PaperError(/^#PWN\d+:/.test(fragment) ? "version" : "format");
  if (
    fragment.length !== LINK_FRAGMENT_MARKER.length + LINK_PAYLOAD_CHARACTERS ||
    !fragment.endsWith(LINK_SUFFIX)
  )
    throw new PaperError("format");
  const bytes = decodeRadix42(
    fragment.slice(LINK_FRAGMENT_MARKER.length, -LINK_SUFFIX.length),
  );
  parseEnvelope(bytes);
  return bytes;
}

/** Extract data only: the host is not an identity claim and is never contacted. */
export function decodeLink(text: string): Uint8Array {
  if (text.length > MAX_LINK_CHARACTERS) throw new PaperError("format");
  const hash = text.indexOf("#");
  if (hash < 0) throw new PaperError("format");
  const base = text.slice(0, hash);
  const fragment = text.slice(hash);
  if (canonicalBaseUrl(base) !== base) throw new PaperError("format");
  return decodeLinkFragment(fragment);
}

/** Shared by camera, image, and pasted QR payload recovery. */
export function decodeQrPayload(text: string): Uint8Array {
  return text.startsWith("PWN:") ? decodeTransport(text) : decodeLink(text);
}
