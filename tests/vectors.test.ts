import { expect, it } from "vitest";
import reference from "./fixtures/reference.json";
import {
  encryptWithRandom,
  decryptEnvelope,
  parseEnvelope,
  associatedData,
} from "../src/format/envelope";
import { derive, fingerprint, open, utf8 } from "../src/crypto/primitives";
import { readCircular } from "../src/format/circular";
import {
  HEADER_BYTES,
  PAYLOAD_BYTES,
  PAYLOAD_OFFSET,
  RECORD_OVERHEAD,
} from "../src/format/constants";

function publicVectorRandom(seed: number) {
  let state = seed >>> 0;
  return (length: number) => {
    const output = new Uint8Array(length);
    for (let index = 0; index < length; index++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      output[index] = state >>> 24;
    }
    return output;
  };
}
it("reproduces the independent Python/OpenSSL envelope byte for byte", async () => {
  const bytes = await encryptWithRandom(
    reference.messages,
    publicVectorRandom(reference.seed),
  );
  expect(Buffer.from(bytes).toString("hex")).toBe(reference.hex);
  expect(await fingerprint(bytes)).toBe(reference.sha256);
});
it("decrypts each message in the independent reference envelope", async () => {
  const bytes = new Uint8Array(Buffer.from(reference.hex, "hex"));
  for (const message of reference.messages)
    expect(await decryptEnvelope(bytes, message.password)).toEqual({
      text: message.text,
    });
  await expect(
    decryptEnvelope(bytes, "not a reference password"),
  ).rejects.toMatchObject({ code: "auth" });
});
it("matches independent circular positions, keys, and lengths, including a wrapped header nonce", async () => {
  const bytes = new Uint8Array(Buffer.from(reference.hex, "hex"));
  const { preamble, salt } = parseEnvelope(bytes);
  expect(reference.messages).toHaveLength(2);
  expect(reference.rotation).toBe(2832);
  expect(reference.rotation + 12).toBeGreaterThan(PAYLOAD_BYTES);
  let expectedPosition = reference.rotation;
  for (let i = 0; i < reference.messages.length; i++) {
    const message = reference.messages[i];
    const coordinates = reference.keys[i];
    const keys = await derive(message.password, salt);
    const headerRecord = readCircular(
      bytes.subarray(PAYLOAD_OFFSET),
      coordinates.position,
      HEADER_BYTES,
    );
    const header = await open(
      keys.header,
      headerRecord.subarray(0, 12),
      headerRecord.subarray(12),
      associatedData("H", preamble, salt, coordinates.position),
    );
    expect(coordinates.position).toBe(expectedPosition);
    expect(
      new DataView(
        header.buffer,
        header.byteOffset,
        header.byteLength,
      ).getUint16(0, true),
    ).toBe(coordinates.length);
    expect(coordinates.length).toBe(utf8.encode(message.text).length);
    const data = readCircular(
      bytes.subarray(PAYLOAD_OFFSET),
      (coordinates.position + HEADER_BYTES) % PAYLOAD_BYTES,
      coordinates.length + 28,
    );
    const plaintext = await open(
      keys.data,
      data.subarray(0, 12),
      data.subarray(12),
      associatedData("D", preamble, salt, coordinates.position, header),
    );
    expect(plaintext).toEqual(utf8.encode(message.text));
    // Import the independent key bytes to verify both derivation outputs without
    // making the application's non-extractable CryptoKeys exportable.
    const independentKey = await crypto.subtle.importKey(
      "raw",
      Buffer.from(coordinates.headerKey, "hex"),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    expect(
      await open(
        independentKey,
        headerRecord.subarray(0, 12),
        headerRecord.subarray(12),
        associatedData("H", preamble, salt, coordinates.position),
      ),
    ).toEqual(header);
    const independentDataKey = await crypto.subtle.importKey(
      "raw",
      Buffer.from(coordinates.dataKey, "hex"),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    expect(
      await open(
        independentDataKey,
        data.subarray(0, 12),
        data.subarray(12),
        associatedData("D", preamble, salt, coordinates.position, header),
      ),
    ).toEqual(plaintext);
    expectedPosition =
      (expectedPosition + coordinates.length + RECORD_OVERHEAD) % PAYLOAD_BYTES;
  }
});
