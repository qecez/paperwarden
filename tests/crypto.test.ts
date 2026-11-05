import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseEnvelope,
  encryptEnvelope,
  decryptEnvelope,
  encryptWithRandom,
  associatedData,
} from "../src/format/envelope";
import {
  BACKUP_BYTES,
  DATA_OVERHEAD,
  HEADER_BYTES,
  MAX_MESSAGES,
  MAX_TEXT_BYTES,
  PAYLOAD_BYTES,
  PAYLOAD_OFFSET,
  PREAMBLE,
  RECORD_OVERHEAD,
  maximumTextBytes,
} from "../src/format/constants";
import {
  sampleRotation,
  readCircular,
  writeCircular,
} from "../src/format/circular";
import * as primitives from "../src/crypto/primitives";
import {
  concat,
  derive,
  fingerprint,
  open,
  seal,
  utf8,
} from "../src/crypto/primitives";
import type { Keys } from "../src/crypto/primitives";

const primary = {
  text: "\uFEFFMain message 🌿\nCafé — 東京  ",
  password: "correct horse river lantern",
};
const secondary = {
  text: "Second independent message",
  password: "different moon stone forest",
};
afterEach(() => vi.restoreAllMocks());

/** Public deterministic test input only; never a production random source. */
function fixtureRandom(seed = 1) {
  let state = seed >>> 0;
  return (length: number) => {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      bytes[i] = state >>> 24;
    }
    return bytes;
  };
}
function atRotation(rotation: number, seed = 42) {
  const random = fixtureRandom(seed);
  return (length: number) =>
    length === 2
      ? new Uint8Array([rotation >> 8, rotation & 255])
      : random(length);
}
function encodedLength(length: number) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, length, true);
  return bytes;
}
async function inspectRecord(
  bytes: Uint8Array,
  password: string,
  position: number,
) {
  const { preamble, salt } = parseEnvelope(bytes);
  const keys = await derive(password, salt);
  const payload = bytes.subarray(PAYLOAD_OFFSET);
  const encryptedHeader = readCircular(payload, position, HEADER_BYTES);
  const header = await open(
    keys.header,
    encryptedHeader.subarray(0, 12),
    encryptedHeader.subarray(12),
    associatedData("H", preamble, salt, position),
  );
  const length = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength,
  ).getUint16(0, true);
  return {
    keys,
    header,
    length,
    record: readCircular(payload, position, RECORD_OVERHEAD + length),
  };
}
async function putHeader(
  bytes: Uint8Array,
  keys: Keys,
  position: number,
  length: number,
) {
  const { preamble, salt } = parseEnvelope(bytes);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  writeCircular(
    bytes.subarray(PAYLOAD_OFFSET),
    position,
    concat(
      nonce,
      await seal(
        keys.header,
        nonce,
        encodedLength(length),
        associatedData("H", preamble, salt, position),
      ),
    ),
  );
}
async function putRecord(
  bytes: Uint8Array,
  keys: Keys,
  position: number,
  plaintext: Uint8Array,
) {
  const { preamble, salt } = parseEnvelope(bytes);
  await putHeader(bytes, keys, position, plaintext.length);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  writeCircular(
    bytes.subarray(PAYLOAD_OFFSET),
    (position + HEADER_BYTES) % PAYLOAD_BYTES,
    concat(
      nonce,
      await seal(
        keys.data,
        nonce,
        plaintext,
        associatedData(
          "D",
          preamble,
          salt,
          position,
          encodedLength(plaintext.length),
        ),
      ),
    ),
  );
}

describe("circular payload bounds and unbiased rotation", () => {
  it("gives every rotation exactly 23 accepted uint16 draws", () => {
    const counts = new Uint8Array(PAYLOAD_BYTES);
    for (let value = 0; value < 65182; value++)
      counts[sampleRotation(() => new Uint8Array([value >> 8, value & 255]))]++;
    expect(Array.from(counts)).toEqual(Array(PAYLOAD_BYTES).fill(23));
  });
  it("rejects the biased tail before selecting a rotation", () => {
    const draws = [65182, 65535, 2833];
    const requested: number[] = [];
    expect(
      sampleRotation((length) => {
        requested.push(length);
        const value = draws.shift();
        if (value === undefined) throw new Error("Unexpected random draw");
        return new Uint8Array([value >> 8, value & 255]);
      }),
    ).toBe(2833);
    expect(draws).toEqual([]);
    expect(requested).toEqual([2, 2, 2]);
  });
  it.each([0, 1, 30, 2833])(
    "wraps full-capacity data at %i without touching the prefix",
    (position) => {
      const backup = new Uint8Array(BACKUP_BYTES).fill(0xa5);
      const payload = backup.subarray(PAYLOAD_OFFSET);
      const data = Uint8Array.from(
        { length: PAYLOAD_BYTES },
        (_, i) => i % 251,
      );
      writeCircular(payload, position, data);
      expect(backup.subarray(0, PAYLOAD_OFFSET)).toEqual(
        new Uint8Array(PAYLOAD_OFFSET).fill(0xa5),
      );
      expect(readCircular(payload, position, data.length)).toEqual(data);
      const copy = readCircular(payload, position, data.length);
      copy.fill(0);
      expect(readCircular(payload, position, data.length)).toEqual(data);
    },
  );
  it("authenticates a record at every possible circular start position", async () => {
    const salt = fixtureRandom()(16);
    const keys = await derive(primary.password, salt);
    const plain = utf8.encode("every position 🌿");
    for (let first = 0; first < PAYLOAD_BYTES; first += 16) {
      await Promise.all(
        Array.from(
          { length: Math.min(16, PAYLOAD_BYTES - first) },
          async (_, index) => {
            const position = first + index;
            const bytes = new Uint8Array(BACKUP_BYTES);
            bytes.set(PREAMBLE);
            bytes.set(salt, 8);
            await putRecord(bytes, keys, position, plain);
            const payload = bytes.subarray(PAYLOAD_OFFSET);
            const header = readCircular(payload, position, HEADER_BYTES);
            const length = await open(
              keys.header,
              header.subarray(0, 12),
              header.subarray(12),
              associatedData("H", PREAMBLE, salt, position),
            );
            expect(length).toEqual(encodedLength(plain.length));
            const data = readCircular(
              payload,
              (position + HEADER_BYTES) % PAYLOAD_BYTES,
              plain.length + DATA_OVERHEAD,
            );
            expect(
              await open(
                keys.data,
                data.subarray(0, 12),
                data.subarray(12),
                associatedData("D", PREAMBLE, salt, position, length),
              ),
            ).toEqual(plain);
          },
        ),
      );
    }
  }, 60000);
  it("bounds circular operations to one complete payload", () => {
    const payload = new Uint8Array(PAYLOAD_BYTES);
    for (const position of [-1, 0.5, PAYLOAD_BYTES, 65535, NaN]) {
      expect(() => readCircular(payload, position, 1)).toThrow(RangeError);
      expect(() => writeCircular(payload, position, new Uint8Array(1))).toThrow(
        RangeError,
      );
    }
    for (const length of [-1, 0.5, PAYLOAD_BYTES + 1, NaN])
      expect(() => readCircular(payload, 0, length)).toThrow(RangeError);
    expect(() =>
      writeCircular(payload, 0, new Uint8Array(PAYLOAD_BYTES + 1)),
    ).toThrow(RangeError);
    expect(() => readCircular(new Uint8Array(PAYLOAD_BYTES - 1), 0, 1)).toThrow(
      RangeError,
    );
    expect(() =>
      writeCircular(new Uint8Array(PAYLOAD_BYTES + 1), 0, new Uint8Array(1)),
    ).toThrow(RangeError);
    expect(readCircular(payload, 0, 0)).toHaveLength(0);
  });
});

describe("fixed envelope with independently protected messages", () => {
  it("keeps every one- and two-message backup at exactly 2,858 bytes", async () => {
    expect([
      BACKUP_BYTES,
      MAX_MESSAGES,
      PAYLOAD_OFFSET,
      PAYLOAD_BYTES,
      HEADER_BYTES,
      RECORD_OVERHEAD,
      MAX_TEXT_BYTES,
    ]).toEqual([2858, 2, 24, 2834, 30, 58, 2776]);
    for (const inputs of [[primary], [primary, secondary]]) {
      const bytes = await encryptEnvelope(inputs);
      expect(bytes).toHaveLength(BACKUP_BYTES);
      expect(bytes.subarray(0, 8)).toEqual(PREAMBLE);
      expect(() => parseEnvelope(bytes)).not.toThrow();
      for (const input of inputs)
        expect(await decryptEnvelope(bytes, input.password)).toEqual({
          text: input.text,
        });
    }
  }, 60000);
  it("derives once and scans every fixed-size header with at most 16 operations in flight", async () => {
    const bytes = await encryptWithRandom([primary], atRotation(0));
    const deriveSpy = vi.spyOn(primitives, "derive");
    const realOpen = primitives.open;
    const positions: number[] = [];
    let pending = 0,
      maximumPending = 0,
      dataCalls = 0;
    vi.spyOn(primitives, "open").mockImplementation(
      async (key, nonce, ciphertext, aad) => {
        if (aad[5] === 0x44) {
          dataCalls++;
          return realOpen(key, nonce, ciphertext, aad);
        }
        expect(nonce).toHaveLength(12);
        expect(ciphertext).toHaveLength(18);
        expect(aad).toHaveLength(32);
        positions.push(
          new DataView(aad.buffer, aad.byteOffset, aad.byteLength).getUint16(
            30,
            true,
          ),
        );
        maximumPending = Math.max(maximumPending, ++pending);
        try {
          return await realOpen(key, nonce, ciphertext, aad);
        } finally {
          pending--;
        }
      },
    );
    expect(await decryptEnvelope(bytes, primary.password)).toEqual({
      text: primary.text,
    });
    expect(deriveSpy).toHaveBeenCalledTimes(1);
    expect(positions.sort((a, b) => a - b)).toEqual(
      Array.from({ length: PAYLOAD_BYTES }, (_, i) => i),
    );
    expect(maximumPending).toBe(16);
    expect(pending).toBe(0);
    expect(dataCalls).toBe(1);
  });
  it("rejects wrong passwords and never returns another message", async () => {
    const bytes = await encryptEnvelope([primary, secondary]);
    await expect(
      decryptEnvelope(bytes, "wrong password"),
    ).rejects.toMatchObject({ code: "auth" });
    expect(await decryptEnvelope(bytes, secondary.password)).toEqual({
      text: secondary.text,
    });
  });
  it("shares capacity and accepts each exact creation boundary", async () => {
    for (let count = 1; count <= MAX_MESSAGES; count++) {
      expect(maximumTextBytes(count)).toBe(2834 - 58 * count);
      const inputs = Array.from({ length: count }, (_, i) => ({
        text: i === 0 ? "a".repeat(maximumTextBytes(count) - count + 1) : "b",
        password: `public boundary password number ${i}`,
      }));
      const bytes = await encryptWithRandom(inputs, atRotation(2833));
      for (const input of inputs)
        expect((await decryptEnvelope(bytes, input.password)).text).toBe(
          input.text,
        );
      inputs[0] = { ...inputs[0], text: inputs[0].text + "a" };
      await expect(encryptEnvelope(inputs)).rejects.toMatchObject({
        code: "capacity",
      });
    }
  }, 60000);
  it("counts UTF-8 bytes, preserves leading BOM and whitespace, and rejects invalid UTF-16", async () => {
    const text = "é".repeat(MAX_TEXT_BYTES / 2);
    const bytes = await encryptEnvelope([{ ...primary, text }]);
    expect((await decryptEnvelope(bytes, primary.password)).text).toBe(text);
    await expect(
      encryptEnvelope([{ ...primary, text: text + "a" }]),
    ).rejects.toMatchObject({ code: "capacity" });
    for (const text of ["", "\ud800", "before\udc00after"])
      await expect(
        encryptEnvelope([{ ...primary, text }]),
      ).rejects.toMatchObject({ code: "empty" });
  });
  it("normalizes passwords to NFC without trimming or case folding", async () => {
    const bytes = await encryptEnvelope([
      { ...primary, password: " cafe\u0301 " },
    ]);
    expect((await decryptEnvelope(bytes, " café ")).text).toBe(primary.text);
    await expect(decryptEnvelope(bytes, "café")).rejects.toThrow();
    await expect(decryptEnvelope(bytes, " CAFÉ ")).rejects.toThrow();
    await expect(
      encryptEnvelope([
        { ...primary, password: "café" },
        { ...secondary, password: "cafe\u0301" },
      ]),
    ).rejects.toMatchObject({ code: "duplicate" });
  });
  it("bounds creation count and password input", async () => {
    await expect(encryptEnvelope([])).rejects.toMatchObject({
      code: "messages",
    });
    await expect(
      encryptEnvelope(Array.from({ length: MAX_MESSAGES + 1 }, () => primary)),
    ).rejects.toMatchObject({ code: "messages" });
    for (const count of [0, MAX_MESSAGES + 1, -1, 1.5, NaN])
      expect(() => maximumTextBytes(count)).toThrow(RangeError);
    for (const password of ["", "\ud800", "é".repeat(513)])
      await expect(
        encryptEnvelope([{ ...primary, password }]),
      ).rejects.toMatchObject({ code: "password" });
    const bytes = await encryptEnvelope([
      { ...primary, password: "é".repeat(512) },
    ]);
    expect((await decryptEnvelope(bytes, "é".repeat(512))).text).toBe(
      primary.text,
    );
  });
  it("uses fresh salts, independent nonces, and random padding", async () => {
    const first = await encryptWithRandom([primary], atRotation(100, 1));
    const second = await encryptWithRandom([primary], atRotation(100, 2));
    expect(first.subarray(0, 8)).toEqual(second.subarray(0, 8));
    expect(first.subarray(8, 24)).not.toEqual(second.subarray(8, 24));
    expect(first.subarray(2600)).not.toEqual(second.subarray(2600));
    const record = (await inspectRecord(first, primary.password, 100)).record;
    expect(record.subarray(0, 12)).not.toEqual(record.subarray(30, 42));
    expect((await decryptEnvelope(second, primary.password)).text).toBe(
      primary.text,
    );
    const randomFirst = await encryptEnvelope([primary]);
    const randomSecond = await encryptEnvelope([primary]);
    expect(randomFirst.subarray(8)).not.toEqual(randomSecond.subarray(8));
  });
  it("keeps a disclosed prefix's coordinates and record independent of a following message", async () => {
    const single = await encryptWithRandom([primary], atRotation(2832));
    const multiple = await encryptWithRandom(
      [primary, secondary],
      atRotation(2832),
    );
    expect(multiple.subarray(0, 24)).toEqual(single.subarray(0, 24));
    const one = await inspectRecord(single, primary.password, 2832);
    const two = await inspectRecord(multiple, primary.password, 2832);
    expect(two.record).toEqual(one.record);
    expect((await decryptEnvelope(multiple, primary.password)).text).toBe(
      primary.text,
    );
    // Structural regression only; this is not a proof of ciphertext pseudorandomness.
  });
  it("allows the same disclosed position at either input position", async () => {
    for (const inputs of [
      [primary, secondary],
      [secondary, primary],
    ]) {
      const priorBytes =
        inputs[0] === primary
          ? 0
          : utf8.encode(secondary.text).length + RECORD_OVERHEAD;
      const rotation = (1 - priorBytes + PAYLOAD_BYTES) % PAYLOAD_BYTES;
      const bytes = await encryptWithRandom(inputs, atRotation(rotation));
      expect((await inspectRecord(bytes, primary.password, 1)).length).toBe(
        utf8.encode(primary.text).length,
      );
      expect((await decryptEnvelope(bytes, primary.password)).text).toBe(
        primary.text,
      );
    }
  });
  it.each([0, 1, 30, 2833])(
    "preserves input order and disjoint records at rotation %i",
    async (rotation) => {
      const inputs = [primary, secondary];
      const bytes = await encryptWithRandom(inputs, atRotation(rotation));
      const occupied = new Set<number>();
      let position = rotation;
      for (const input of inputs) {
        const record = await inspectRecord(bytes, input.password, position);
        expect(record.length).toBe(utf8.encode(input.text).length);
        for (let k = 0; k < record.record.length; k++) {
          const at = (position + k) % PAYLOAD_BYTES;
          expect(occupied.has(at)).toBe(false);
          occupied.add(at);
        }
        position = (position + record.record.length) % PAYLOAD_BYTES;
        expect((await decryptEnvelope(bytes, input.password)).text).toBe(
          input.text,
        );
      }
    },
    60000,
  );
  it.each([
    [2833, "header nonce"],
    [2821, "encrypted length"],
    [2810, "header tag"],
    [2799, "data nonce"],
    [2787, "data ciphertext"],
    [2770, "data tag"],
  ])(
    "authenticates a record at %i whose %s crosses the boundary",
    async (position) => {
      const input = { ...primary, text: "abcdefghijklmnop" };
      const bytes = await encryptWithRandom(
        [input],
        atRotation(position as number),
      );
      expect((await decryptEnvelope(bytes, input.password)).text).toBe(
        input.text,
      );
      // Flip the byte after the circular boundary in each record component.
      const changed = bytes.slice();
      changed[PAYLOAD_OFFSET] ^= 1;
      await expect(
        decryptEnvelope(changed, input.password),
      ).rejects.toMatchObject({ code: "auth" });
    },
    60000,
  );
  it("authenticates its record without authenticating other records or filler", async () => {
    const bytes = await encryptWithRandom([primary, secondary], atRotation(0));
    const secondPosition = utf8.encode(primary.text).length + RECORD_OVERHEAD;
    const damaged = bytes.slice();
    damaged[PAYLOAD_OFFSET + secondPosition + HEADER_BYTES + 12] ^= 1;
    expect((await decryptEnvelope(damaged, primary.password)).text).toBe(
      primary.text,
    );
    await expect(
      decryptEnvelope(damaged, secondary.password),
    ).rejects.toMatchObject({ code: "auth" });
    const filler = bytes.slice();
    filler[BACKUP_BYTES - 1] ^= 1;
    for (const input of [primary, secondary])
      expect((await decryptEnvelope(filler, input.password)).text).toBe(
        input.text,
      );
  });
  it("detects changed backups even when a known record still opens", async () => {
    const bytes = await encryptWithRandom(
      [primary, secondary],
      atRotation(2833),
    );
    const known = await inspectRecord(bytes, primary.password, 2833);
    const changed = bytes.slice();
    changed.set(fixtureRandom(990)(PAYLOAD_BYTES), PAYLOAD_OFFSET);
    writeCircular(changed.subarray(PAYLOAD_OFFSET), 2833, known.record);
    expect(await decryptEnvelope(changed, primary.password)).toEqual({
      text: primary.text,
    });
    await expect(
      decryptEnvelope(changed, secondary.password),
    ).rejects.toMatchObject({ code: "auth" });
    expect(await fingerprint(changed)).not.toBe(await fingerprint(bytes));
  });
  it("allows insertion of a message only into a changed backup", async () => {
    const original = await encryptWithRandom([primary], atRotation(2833));
    const changed = original.slice();
    const keys = await derive(secondary.password, parseEnvelope(original).salt);
    const position =
      (2833 + RECORD_OVERHEAD + utf8.encode(primary.text).length) %
      PAYLOAD_BYTES;
    await putRecord(changed, keys, position, utf8.encode(secondary.text));
    for (const input of [primary, secondary])
      expect(await decryptEnvelope(changed, input.password)).toEqual({
        text: input.text,
      });
    await expect(
      decryptEnvelope(original, secondary.password),
    ).rejects.toMatchObject({ code: "auth" });
    expect(await fingerprint(changed)).not.toBe(await fingerprint(original));
  });
  it("rejects malformed public fields and envelope lengths", async () => {
    const bytes = await encryptWithRandom([primary], fixtureRandom());
    for (const position of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const malformed = bytes.slice();
      malformed[position] ^= 0xff;
      expect(() => parseEnvelope(malformed)).toThrow();
      await expect(
        decryptEnvelope(malformed, primary.password),
      ).rejects.toThrow();
    }
    expect(() => parseEnvelope(bytes.subarray(0, bytes.length - 1))).toThrow();
    expect(() => parseEnvelope(new Uint8Array(BACKUP_BYTES + 1))).toThrow();
    const changedSalt = bytes.slice();
    changedSalt[8] ^= 1;
    await expect(
      decryptEnvelope(changedSalt, primary.password),
    ).rejects.toMatchObject({ code: "auth" });
  });
  it("rejects authenticated invalid lengths before gathering data", async () => {
    const bytes = await encryptWithRandom([primary], atRotation(2833));
    const keys = await derive(primary.password, parseEnvelope(bytes).salt);
    const openSpy = vi.spyOn(primitives, "open");
    for (const length of [0, MAX_TEXT_BYTES + 1, 65535]) {
      const changed = bytes.slice();
      await putHeader(changed, keys, 2833, length);
      openSpy.mockClear();
      await expect(
        decryptEnvelope(changed, primary.password),
      ).rejects.toMatchObject({ code: "auth" });
      expect(openSpy).toHaveBeenCalledTimes(PAYLOAD_BYTES);
      expect(openSpy.mock.calls.every((call) => call[3][5] === 0x48)).toBe(
        true,
      );
    }
  });
  it("rejects malformed authenticated UTF-8", async () => {
    const bytes = await encryptWithRandom([primary], atRotation(2833));
    const keys = await derive(primary.password, parseEnvelope(bytes).salt);
    for (const plaintext of [
      new Uint8Array([0xff]),
      new Uint8Array([0xc0, 0xaf]),
      new Uint8Array([0xed, 0xa0, 0x80]),
    ]) {
      const changed = bytes.slice();
      await putRecord(changed, keys, 2833, plaintext);
      await expect(
        decryptEnvelope(changed, primary.password),
      ).rejects.toMatchObject({ code: "auth" });
    }
  });
  it("binds the position and authenticated length to the data tag", async () => {
    const bytes = await encryptWithRandom([primary], atRotation(0));
    const original = await inspectRecord(bytes, primary.password, 0);
    const relocated = bytes.slice();
    relocated.fill(0, PAYLOAD_OFFSET, PAYLOAD_OFFSET + original.record.length);
    writeCircular(relocated.subarray(PAYLOAD_OFFSET), 500, original.record);
    // Even a correctly authenticated replacement header cannot relocate its data.
    await putHeader(relocated, original.keys, 500, original.length);
    await expect(
      decryptEnvelope(relocated, primary.password),
    ).rejects.toMatchObject({ code: "auth" });
    const changedLength = bytes.slice();
    await putHeader(changedLength, original.keys, 0, original.length - 1);
    await expect(
      decryptEnvelope(changedLength, primary.password),
    ).rejects.toMatchObject({ code: "auth" });
  });
  it("rejects header relocation and transplantation across salts", async () => {
    const bytes = await encryptWithRandom([primary], atRotation(0, 1));
    const original = await inspectRecord(bytes, primary.password, 0);
    const relocated = bytes.slice();
    relocated.fill(0, PAYLOAD_OFFSET, PAYLOAD_OFFSET + original.record.length);
    writeCircular(relocated.subarray(PAYLOAD_OFFSET), 500, original.record);
    await expect(
      decryptEnvelope(relocated, primary.password),
    ).rejects.toMatchObject({ code: "auth" });
    const transplanted = await encryptWithRandom(
      [secondary],
      atRotation(500, 2),
    );
    writeCircular(transplanted.subarray(PAYLOAD_OFFSET), 0, original.record);
    await expect(
      decryptEnvelope(transplanted, primary.password),
    ).rejects.toMatchObject({ code: "auth" });
  });
  it("rejects multiple authenticated headers before interpreting even an invalid length", async () => {
    const bytes = await encryptWithRandom([primary], atRotation(0));
    const keys = await derive(primary.password, parseEnvelope(bytes).salt);
    const openSpy = vi.spyOn(primitives, "open");
    for (const length of [1, 0, MAX_TEXT_BYTES + 1, 65535]) {
      const ambiguous = bytes.slice();
      await putHeader(ambiguous, keys, 500, length);
      openSpy.mockClear();
      await expect(
        decryptEnvelope(ambiguous, primary.password),
      ).rejects.toMatchObject({ code: "auth" });
      expect(openSpy).toHaveBeenCalledTimes(PAYLOAD_BYTES);
      expect(openSpy.mock.calls.every((call) => call[3][5] === 0x48)).toBe(
        true,
      );
    }
  });
});
