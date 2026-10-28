import { PaperError } from "../crypto/errors";
import { BACKUP_BYTES } from "../format/constants";
import { parseEnvelope } from "../format/envelope";

// RFC 9285: spaces are data. Never trim, URL-decode, or change case here.
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const PREFIX = "PWN:";
const SUFFIX = ":END";
export const BASE45_CHARACTERS = Math.ceil((BACKUP_BYTES * 3) / 2);
export const TRANSPORT_CHARACTERS =
  BASE45_CHARACTERS + PREFIX.length + SUFFIX.length;

export function encodeBase45(bytes: Uint8Array): string {
  if (bytes.length > BACKUP_BYTES) throw new PaperError("format");
  let encoded = "";
  for (let i = 0; i < bytes.length; i += 2) {
    const paired = i + 1 < bytes.length;
    let value = paired ? bytes[i] * 256 + bytes[i + 1] : bytes[i];
    encoded += ALPHABET[value % 45];
    value = Math.floor(value / 45);
    encoded += ALPHABET[value % 45];
    if (paired) encoded += ALPHABET[Math.floor(value / 45)];
  }
  return encoded;
}

export function decodeBase45(encoded: string): Uint8Array {
  if (encoded.length > BASE45_CHARACTERS || encoded.length % 3 === 1) {
    throw new PaperError("format");
  }
  const bytes = new Uint8Array(Math.floor((encoded.length * 2) / 3));
  let offset = 0;
  for (let i = 0; i < encoded.length; i += 3) {
    const count = Math.min(3, encoded.length - i);
    const first = ALPHABET.indexOf(encoded[i]);
    const second = ALPHABET.indexOf(encoded[i + 1]);
    const third = count === 3 ? ALPHABET.indexOf(encoded[i + 2]) : 0;
    if (first < 0 || second < 0 || third < 0) throw new PaperError("format");
    const value = first + 45 * second + 2025 * third;
    if (value > (count === 3 ? 65535 : 255)) throw new PaperError("format");
    if (count === 3) bytes[offset++] = Math.floor(value / 256);
    bytes[offset++] = value % 256;
  }
  return bytes;
}

export function encodeTransport(bytes: Uint8Array): string {
  parseEnvelope(bytes);
  return PREFIX + encodeBase45(bytes) + SUFFIX;
}

export function decodeTransport(text: string): Uint8Array {
  if (
    text.length !== TRANSPORT_CHARACTERS ||
    !text.startsWith(PREFIX) ||
    !text.endsWith(SUFFIX)
  ) {
    throw new PaperError("format");
  }
  const bytes = decodeBase45(text.slice(PREFIX.length, -SUFFIX.length));
  parseEnvelope(bytes);
  return bytes;
}
