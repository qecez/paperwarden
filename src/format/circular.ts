import { PAYLOAD_BYTES } from "./constants";

/** Uniform over every payload byte. Rejection avoids bias from uint16 modulo. */
export function sampleRotation(random: (length: number) => Uint8Array): number {
  const bound = 65536 - (65536 % PAYLOAD_BYTES);
  let value: number;
  do {
    const bytes = random(2);
    value = bytes[0] * 256 + bytes[1];
  } while (value >= bound);
  return value % PAYLOAD_BYTES;
}

function check(payload: Uint8Array, offset: number, length: number): void {
  if (
    payload.length !== PAYLOAD_BYTES ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset >= PAYLOAD_BYTES ||
    !Number.isInteger(length) ||
    length < 0 ||
    length > PAYLOAD_BYTES
  )
    throw new RangeError("Invalid circular payload bounds");
}

/** A bounded record has at most one wrap. The public prefix never wraps. */
export function writeCircular(
  payload: Uint8Array,
  offset: number,
  bytes: Uint8Array,
): void {
  check(payload, offset, bytes.length);
  const first = Math.min(bytes.length, PAYLOAD_BYTES - offset);
  payload.set(bytes.subarray(0, first), offset);
  payload.set(bytes.subarray(first), 0);
}

export function readCircular(
  payload: Uint8Array,
  offset: number,
  length: number,
): Uint8Array {
  check(payload, offset, length);
  const first = Math.min(length, PAYLOAD_BYTES - offset);
  const bytes = new Uint8Array(length);
  bytes.set(payload.subarray(offset, offset + first));
  bytes.set(payload.subarray(0, length - first), first);
  return bytes;
}
