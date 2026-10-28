import { PaperError } from "../crypto/errors";
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
  DIRECTORY_OFFSET,
  HEADER_BYTES,
  MAX_MESSAGES,
  MAX_TEXT_BYTES,
  PAYLOAD_BYTES,
  PAYLOAD_OFFSET,
  PREAMBLE,
  PREAMBLE_BYTES,
  RECORD_OVERHEAD,
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
    salt: bytes.slice(PREAMBLE_BYTES, DIRECTORY_OFFSET),
  };
}
/** Each tag authenticates only its own record; never the directory or another message. */
export function associatedData(
  kind: "H" | "D",
  preamble: Uint8Array,
  salt: Uint8Array,
  slot: number,
  header?: Uint8Array,
): Uint8Array {
  return concat(
    utf8.encode(`PWN1-${kind}`),
    preamble,
    salt,
    new Uint8Array([slot]),
    ...(header ? [header] : []),
  );
}
export type RandomSource = (length: number) => Uint8Array;
const secureRandom: RandomSource = (length) =>
  crypto.getRandomValues(new Uint8Array(length));
function shuffledSlots(random: RandomSource): number[] {
  const slots = Array.from({ length: MAX_MESSAGES }, (_, i) => i);
  for (let i = slots.length - 1; i > 0; i--) {
    const range = i + 1,
      bound = 256 - (256 % range);
    let value: number;
    do {
      value = random(1)[0];
    } while (value >= bound);
    const selected = value % range;
    [slots[i], slots[selected]] = [slots[selected], slots[i]];
  }
  return slots;
}
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
    const salt = random(16);
    result.set(PREAMBLE);
    result.set(salt, PREAMBLE_BYTES);
    // Always shuffle the entire directory, independently of the occupied-message count.
    const slots = shuffledSlots(random);
    let offset = 0;
    for (let index = 0; index < messages.length; index++) {
      const slot = slots[index],
        keys = await derive(messages[index].password, salt);
      const header = new Uint8Array(4),
        view = new DataView(header.buffer);
      view.setUint16(0, offset, true);
      view.setUint16(2, texts[index].length, true);
      const headerNonce = random(12),
        dataNonce = random(12);
      result.set(
        concat(
          headerNonce,
          await seal(
            keys.header,
            headerNonce,
            header,
            associatedData("H", PREAMBLE, salt, slot),
          ),
        ),
        DIRECTORY_OFFSET + HEADER_BYTES * slot,
      );
      result.set(
        concat(
          dataNonce,
          await seal(
            keys.data,
            dataNonce,
            texts[index],
            associatedData("D", PREAMBLE, salt, slot, header),
          ),
        ),
        PAYLOAD_OFFSET + offset,
      );
      offset += RECORD_OVERHEAD + texts[index].length;
      header.fill(0);
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
  const candidates: { slot: number; header: Uint8Array }[] = [];
  try {
    // Examine all slots even after a match; reject malformed ambiguous envelopes.
    for (let slot = 0; slot < MAX_MESSAGES; slot++) {
      const at = DIRECTORY_OFFSET + slot * HEADER_BYTES;
      try {
        const header = await open(
          keys.header,
          container.subarray(at, at + 12),
          container.subarray(at + 12, at + HEADER_BYTES),
          associatedData("H", preamble, salt, slot),
        );
        candidates.push({ slot, header });
      } catch {
        /* A nonmatching password and an unused random slot have the same result. */
      }
    }
    if (candidates.length !== 1) throw new PaperError("auth");
    const { slot, header } = candidates[0];
    const view = new DataView(
      header.buffer,
      header.byteOffset,
      header.byteLength,
    );
    const offset = view.getUint16(0, true),
      length = view.getUint16(2, true);
    if (
      length === 0 ||
      length > MAX_TEXT_BYTES ||
      (offset !== 0 && offset < RECORD_OVERHEAD + 1) ||
      offset + RECORD_OVERHEAD + length > PAYLOAD_BYTES
    )
      throw new PaperError("auth");
    const at = PAYLOAD_OFFSET + offset;
    let plain: Uint8Array | undefined;
    try {
      plain = await open(
        keys.data,
        container.subarray(at, at + 12),
        container.subarray(at + 12, at + RECORD_OVERHEAD + length),
        associatedData("D", preamble, salt, slot, header),
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
    candidates.forEach((candidate) => candidate.header.fill(0));
  }
}
