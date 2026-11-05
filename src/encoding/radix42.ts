import { PaperError } from "../crypto/errors";
import { BACKUP_BYTES } from "../format/constants";

// Periods in encrypted URL fragments can make iPhone Camera offer Search.
// Keep the remaining URL-safe QR alphanumeric characters, in this fixed order.
export const RADIX42_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$*+-/:";
export const RADIX42_CHARACTERS = 4241;
const BLOCK_BYTES = 31;
const BLOCK_CHARACTERS = 46;
const FULL_BLOCKS = 92;
const LAST_BLOCK_BYTES = 6;
const LAST_BLOCK_CHARACTERS = 9;

/** Fixed-width big-endian radix42; transports every byte without compression. */
export function encodeRadix42(bytes: Uint8Array): string {
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
      digits = RADIX42_ALPHABET[Number(value % 42n)] + digits;
      value /= 42n;
    }
    text += digits;
  }
  return text;
}

export function decodeRadix42(text: string): Uint8Array {
  if (text.length !== RADIX42_CHARACTERS) throw new PaperError("format");
  const bytes = new Uint8Array(BACKUP_BYTES);
  for (let block = 0; block <= FULL_BLOCKS; block++) {
    const size = block < FULL_BLOCKS ? BLOCK_BYTES : LAST_BLOCK_BYTES;
    const width =
      block < FULL_BLOCKS ? BLOCK_CHARACTERS : LAST_BLOCK_CHARACTERS;
    let value = 0n;
    for (let i = 0; i < width; i++) {
      const digit = RADIX42_ALPHABET.indexOf(
        text[block * BLOCK_CHARACTERS + i],
      );
      if (digit < 0) throw new PaperError("format");
      value = value * 42n + BigInt(digit);
    }
    // Reject unused values rather than truncating high bits into aliases.
    if (value >= 1n << BigInt(size * 8)) throw new PaperError("format");
    for (let i = size - 1; i >= 0; i--) {
      bytes[block * BLOCK_BYTES + i] = Number(value & 255n);
      value >>= 8n;
    }
  }
  return bytes;
}
