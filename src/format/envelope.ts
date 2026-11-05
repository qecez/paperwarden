import { PaperError } from "../crypto/errors";
import { readCircular, sampleRotation, writeCircular } from "./circular";
import {
  concat,
  derive,
  open,
  passwordBytes,
  seal,
  utf8,
  wellFormed,
} from "../crypto/primitives";
import {
  BACKUP_BYTES,
  DATA_OVERHEAD,
  HEADER_BYTES,
  MAX_MESSAGES,
  MAX_TEXT_BYTES,
  PAYLOAD_BYTES,
  PAYLOAD_OFFSET,
  PREAMBLE,
  PREAMBLE_BYTES,
  RECORD_OVERHEAD,
  SALT_BYTES,
  maximumTextBytes,
} from "./constants";
export interface SecretInput {
  text: string;
  password: string;
}
export interface Envelope {
  preamble: Uint8Array;
  salt: Uint8Array;
}
export function parseEnvelope(bytes: Uint8Array): Envelope {
  if (!(bytes instanceof Uint8Array) || bytes.length !== BACKUP_BYTES)
    throw new PaperError("format");
  for (let i = 0; i < 4; i++)
    if (bytes[i] !== PREAMBLE[i]) throw new PaperError("format");
  if (bytes[4] !== 1) throw new PaperError("version");
  if (bytes[5] !== 1) throw new PaperError("profile");
  if (bytes[6] !== 0 || bytes[7] !== 0) throw new PaperError("format");
  return {
    preamble: bytes.slice(0, PREAMBLE_BYTES),
    salt: bytes.slice(PREAMBLE_BYTES, PAYLOAD_OFFSET),
  };
}
/** Each tag binds its record to the prefix and its circular start position. */
export function associatedData(
  kind: "H" | "D",
  preamble: Uint8Array,
  salt: Uint8Array,
  position: number,
  length?: Uint8Array,
): Uint8Array {
  const encodedPosition = new Uint8Array(2);
  new DataView(encodedPosition.buffer).setUint16(0, position, true);
  return concat(
    utf8.encode(`PWN1-${kind}`),
    preamble,
    salt,
    encodedPosition,
    ...(length ? [length] : []),
  );
}
export type RandomSource = (length: number) => Uint8Array;
const secureRandom: RandomSource = (length) =>
  crypto.getRandomValues(new Uint8Array(length));
/** Test seam only; the UI and worker always call encryptEnvelope with the platform CSPRNG. */
export async function encryptWithRandom(
  messages: SecretInput[],
  random: RandomSource,
): Promise<Uint8Array> {
  if (
    !Array.isArray(messages) ||
    messages.length < 1 ||
    messages.length > MAX_MESSAGES
  )
    throw new PaperError("messages");
  const texts: Uint8Array[] = [];
  const passwords = new Set<string>();
  try {
    for (const message of messages) {
      if (
        !message ||
        typeof message.text !== "string" ||
        !message.text.length ||
        !wellFormed(message.text)
      )
        throw new PaperError("empty");
      if (message.text.length > MAX_TEXT_BYTES)
        throw new PaperError("capacity");
      passwordBytes(message.password).fill(0);
      const normalized = message.password.normalize("NFC");
      if (passwords.has(normalized)) throw new PaperError("duplicate");
      passwords.add(normalized);
      texts.push(utf8.encode(message.text));
    }
    if (
      texts.reduce((sum, text) => sum + text.length, 0) >
      maximumTextBytes(messages.length)
    )
      throw new PaperError("capacity");
    const result = random(BACKUP_BYTES);
    const salt = random(SALT_BYTES);
    result.set(PREAMBLE);
    result.set(salt, PREAMBLE_BYTES);
    // Keep input order and rotate the complete packed stream. Every record's
    // position is uniform, independently of the number of occupied bytes.
    let position = sampleRotation(random);
    const payload = result.subarray(PAYLOAD_OFFSET);
    for (let index = 0; index < messages.length; index++) {
      const keys = await derive(messages[index].password, salt);
      const length = new Uint8Array(2);
      new DataView(length.buffer).setUint16(0, texts[index].length, true);
      const headerNonce = random(12),
        dataNonce = random(12);
      try {
        writeCircular(
          payload,
          position,
          concat(
            headerNonce,
            await seal(
              keys.header,
              headerNonce,
              length,
              associatedData("H", PREAMBLE, salt, position),
            ),
            dataNonce,
            await seal(
              keys.data,
              dataNonce,
              texts[index],
              associatedData("D", PREAMBLE, salt, position, length),
            ),
          ),
        );
      } finally {
        length.fill(0);
      }
      position =
        (position + RECORD_OVERHEAD + texts[index].length) % PAYLOAD_BYTES;
    }
    return result;
  } finally {
    texts.forEach((text) => text.fill(0));
    passwords.clear();
  }
}
export const encryptEnvelope = (messages: SecretInput[]): Promise<Uint8Array> =>
  encryptWithRandom(messages, secureRandom);
export async function decryptEnvelope(
  container: Uint8Array,
  password: string,
): Promise<{ text: string }> {
  const { preamble, salt } = parseEnvelope(container);
  const keys = await derive(password, salt);
  const payload = container.subarray(PAYLOAD_OFFSET);
  const candidates: { position: number; length: Uint8Array }[] = [];
  let nextPosition = 0;
  try {
    // Fixed-size candidates at every byte; bound the number of simultaneous
    // Web Crypto operations, and finish the scan even after a match.
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        while (nextPosition < PAYLOAD_BYTES) {
          const position = nextPosition++;
          const header = readCircular(payload, position, HEADER_BYTES);
          try {
            const length = await open(
              keys.header,
              header.subarray(0, 12),
              header.subarray(12),
              associatedData("H", preamble, salt, position),
            );
            candidates.push({ position, length });
          } catch {
            /* Wrong passwords, filler, and other records have the same result. */
          }
        }
      }),
    );
    // Authentication ambiguity must be rejected before interpreting lengths:
    // even an authenticated malformed length counts as a matching header.
    if (candidates.length !== 1) throw new PaperError("auth");
    const { position, length: encodedLength } = candidates[0];
    const length = new DataView(
      encodedLength.buffer,
      encodedLength.byteOffset,
      encodedLength.byteLength,
    ).getUint16(0, true);
    if (length === 0 || length > MAX_TEXT_BYTES) throw new PaperError("auth");
    const data = readCircular(
      payload,
      (position + HEADER_BYTES) % PAYLOAD_BYTES,
      DATA_OVERHEAD + length,
    );
    let plain: Uint8Array | undefined;
    try {
      plain = await open(
        keys.data,
        data.subarray(0, 12),
        data.subarray(12),
        associatedData("D", preamble, salt, position, encodedLength),
      );
      return {
        text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          plain,
        ),
      };
    } catch {
      throw new PaperError("auth");
    } finally {
      plain?.fill(0);
    }
  } finally {
    candidates.forEach((candidate) => candidate.length.fill(0));
  }
}
