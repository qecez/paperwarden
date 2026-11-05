import { PaperError } from "../crypto/errors";
import { fingerprint } from "../crypto/primitives";
import { BACKUP_BYTES } from "../format/constants";
import { parseEnvelope } from "../format/envelope";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ARCHIVE_LABEL = "PWN-1 ARCHIVE";
export const ARCHIVE_BEGIN = "-----BEGIN PAPERWARDEN BACKUP-----";
export const ARCHIVE_END = "-----END PAPERWARDEN BACKUP-----";
export const ARCHIVE_LINE_LENGTH = 40;
export const ARCHIVE_DATA_CHARACTERS = Math.ceil((BACKUP_BYTES * 8) / 5);
export const ARCHIVE_LINES = Math.ceil(
  ARCHIVE_DATA_CHARACTERS / ARCHIVE_LINE_LENGTH,
);
export const MAX_ARCHIVE_CHARACTERS = 10000;
const utf8 = new TextEncoder();

export function encodeBase32(bytes: Uint8Array): string {
  if (bytes.length > BACKUP_BYTES) throw new PaperError("archive");
  let buffer = 0;
  let bits = 0;
  let output = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += ALPHABET[(buffer >>> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits !== 0) output += ALPHABET[buffer << (5 - bits)];
  return output;
}

export function decodeBase32(text: string): Uint8Array {
  if (text.length > ARCHIVE_DATA_CHARACTERS) throw new PaperError("archive");
  const bytes = new Uint8Array(Math.floor((text.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const char of text) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw new PaperError("archive");
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = buffer >>> bits;
    }
    buffer &= (1 << bits) - 1;
  }
  if (buffer !== 0 || encodeBase32(bytes) !== text)
    throw new PaperError("archive");
  return bytes;
}

async function lineChecksum(index: number, data: string): Promise<string> {
  return (await fingerprint(utf8.encode(`PWN1-LINE:${index}:${data}`)))
    .slice(0, 8)
    .toUpperCase();
}

/** Copy-error checks, not signatures: each recovered message is authenticated separately. */
export async function encodeArchive(bytes: Uint8Array): Promise<string> {
  parseEnvelope(bytes);
  const data = encodeBase32(bytes);
  const lines = [
    ARCHIVE_BEGIN,
    ARCHIVE_LABEL,
    `SHA256 ${await fingerprint(bytes)}`,
  ];
  for (let offset = 0; offset < data.length; offset += ARCHIVE_LINE_LENGTH) {
    const index = offset / ARCHIVE_LINE_LENGTH + 1;
    const chunk = data.slice(offset, offset + ARCHIVE_LINE_LENGTH);
    const groups = chunk.match(/.{1,5}/g)!.join(" ");
    lines.push(
      `${String(index).padStart(3, "0")} ${groups} ${await lineChecksum(index, chunk)}`,
    );
  }
  return [...lines, ARCHIVE_END].join("\n");
}

export async function decodeArchive(text: string): Promise<Uint8Array> {
  if (text.length > MAX_ARCHIVE_CHARACTERS) throw new PaperError("archive");
  // Unlike Base45 transport, Base32 group spacing is presentation only.
  // PDF text extraction can add blank lines and form-feed page separators;
  // ignore those without joining or repairing numbered data lines.
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/\f/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length !== 0);
  if (lines[0] === ARCHIVE_BEGIN) {
    if (lines.at(-1) !== ARCHIVE_END) throw new PaperError("archive");
    lines.shift();
    lines.pop();
  }
  const checksum = /^SHA256[ \t]+([a-fA-F0-9]{64})$/.exec(lines[1] ?? "");
  if (
    lines[0] !== ARCHIVE_LABEL ||
    !checksum ||
    lines.length !== ARCHIVE_LINES + 2
  ) {
    throw new PaperError("archive");
  }
  let data = "";
  for (let line = 0; line < ARCHIVE_LINES; line++) {
    // Tokenize once to avoid ambiguous whitespace matches on malformed input.
    const fields = lines[line + 2].split(/[ \t]+/);
    const number = fields.shift() ?? "";
    const expectedChecksum = fields.pop() ?? "";
    const chunk = fields.join("");
    if (
      !/^\d{3}$/.test(number) ||
      Number(number) !== line + 1 ||
      !/^[0-9A-F]{8}$/.test(expectedChecksum) ||
      !/^[0-9A-HJKMNP-TV-Z]+$/.test(chunk)
    )
      throw new PaperError("archive");
    const expectedLength = Math.min(
      ARCHIVE_LINE_LENGTH,
      ARCHIVE_DATA_CHARACTERS - line * ARCHIVE_LINE_LENGTH,
    );
    if (
      chunk.length !== expectedLength ||
      (await lineChecksum(line + 1, chunk)) !== expectedChecksum
    ) {
      throw new PaperError("archive");
    }
    data += chunk;
  }
  const bytes = decodeBase32(data);
  if ((await fingerprint(bytes)) !== checksum[1].toLowerCase())
    throw new PaperError("archive");
  parseEnvelope(bytes);
  return bytes;
}
