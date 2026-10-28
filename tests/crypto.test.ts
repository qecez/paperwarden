import { describe, expect, it } from "vitest";
import {
  parseEnvelope,
  encryptEnvelope,
  decryptEnvelope,
  encryptWithRandom,
  associatedData,
} from "../src/format/envelope";
import {
  BACKUP_BYTES,
  MAX_MESSAGES,
  MAX_TEXT_BYTES,
  maximumTextBytes,
} from "../src/format/constants";
import { concat, derive, open, seal } from "../src/crypto/primitives";

const primary = {
  text: "Main message 🌿\n\uFEFFCafé — 東京  ",
  password: "correct horse river lantern",
};
const more = [
  {
    text: "Second independent message",
    password: "different moon stone forest",
  },
  { text: "Third private message", password: "third autumn sky waterfall" },
  { text: "Fourth message", password: "fourth willow lake garden" },
];

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

describe("fixed envelope with independently protected messages", () => {
  it("keeps every one-to-four-message backup at exactly 2,858 bytes", async () => {
    expect(BACKUP_BYTES).toBe(2858);
    expect(MAX_MESSAGES).toBe(4);
    expect(MAX_TEXT_BYTES).toBe(2678);
    const inputs = [primary, ...more];
    for (let count = 1; count <= MAX_MESSAGES; count++) {
      const bytes = await encryptEnvelope(inputs.slice(0, count));
      expect(bytes).toHaveLength(BACKUP_BYTES);
      expect(Array.from(bytes.subarray(0, 8))).toEqual([
        0x50, 0x57, 0x4e, 0x58, 1, 1, 0, 0,
      ]);
      expect(() => parseEnvelope(bytes)).not.toThrow();
      for (const input of inputs.slice(0, count)) {
        expect(await decryptEnvelope(bytes, input.password)).toEqual({
          text: input.text,
        });
      }
    }
  }, 60000);

  it("rejects wrong passwords and never returns another message", async () => {
    const bytes = await encryptEnvelope([primary, ...more]);
    await expect(decryptEnvelope(bytes, "wrong password")).rejects.toThrow();
    expect(await decryptEnvelope(bytes, more[2].password)).toEqual({
      text: more[2].text,
    });
  });

  it("shares capacity and accepts each exact one-to-four-message boundary", async () => {
    for (let count = 1; count <= MAX_MESSAGES; count++) {
      expect(maximumTextBytes(count)).toBe(2706 - 28 * count);
      const inputs = Array.from({ length: count }, (_, i) => ({
        text: i === 0 ? "a".repeat(maximumTextBytes(count) - count + 1) : "b",
        password: `public boundary password number ${i}`,
      }));
      const bytes = await encryptEnvelope(inputs);
      expect(bytes).toHaveLength(BACKUP_BYTES);
      expect((await decryptEnvelope(bytes, inputs[0].password)).text).toBe(
        inputs[0].text,
      );
      inputs[0] = { ...inputs[0], text: inputs[0].text + "a" };
      await expect(encryptEnvelope(inputs)).rejects.toThrow();
    }
  }, 60000);

  it("counts UTF-8 bytes, preserves text exactly, and rejects invalid UTF-16", async () => {
    const text = "é".repeat(MAX_TEXT_BYTES / 2);
    const bytes = await encryptEnvelope([{ ...primary, text }]);
    expect((await decryptEnvelope(bytes, primary.password)).text).toBe(text);
    await expect(
      encryptEnvelope([{ ...primary, text: text + "a" }]),
    ).rejects.toThrow();
    for (const text of ["", "\ud800", "before\udc00after"]) {
      await expect(encryptEnvelope([{ ...primary, text }])).rejects.toThrow();
    }
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
        { ...more[0], password: "cafe\u0301" },
      ]),
    ).rejects.toThrow();
  });

  it("bounds message count and password input", async () => {
    await expect(encryptEnvelope([])).rejects.toThrow();
    await expect(
      encryptEnvelope([primary, ...more, { ...primary, password: "fifth" }]),
    ).rejects.toThrow();
    for (const password of ["", "\ud800", "é".repeat(513)]) {
      await expect(
        encryptEnvelope([{ ...primary, password }]),
      ).rejects.toThrow();
    }
    const bytes = await encryptEnvelope([
      { ...primary, password: "é".repeat(512) },
    ]);
    expect((await decryptEnvelope(bytes, "é".repeat(512))).text).toBe(
      primary.text,
    );
  });

  it("uses fresh salts and random padding even for identical inputs", async () => {
    const first = await encryptEnvelope([primary]);
    const second = await encryptEnvelope([primary]);
    expect(first.subarray(0, 8)).toEqual(second.subarray(0, 8));
    expect(first.subarray(8, 24)).not.toEqual(second.subarray(8, 24));
    expect(first.subarray(24, 152)).not.toEqual(second.subarray(24, 152));
    expect(first.subarray(2600)).not.toEqual(second.subarray(2600));
    expect((await decryptEnvelope(second, primary.password)).text).toBe(
      primary.text,
    );
  });

  it("does not make the first message's authenticated bytes depend on later-message count", async () => {
    // Reusing randomness is intentionally restricted to this public test. It lets
    // us compare exactly which bytes the writer makes depend on later messages.
    const single = await encryptWithRandom([primary], fixtureRandom(42));
    const multiple = await encryptWithRandom(
      [primary, ...more],
      fixtureRandom(42),
    );
    const { preamble, salt } = parseEnvelope(single);
    const keys = await derive(primary.password, salt);
    let headerAt = -1;
    for (let slot = 0; slot < 4; slot++) {
      const at = 24 + slot * 32;
      try {
        await open(
          keys.header,
          single.subarray(at, at + 12),
          single.subarray(at + 12, at + 32),
          associatedData("H", preamble, salt, slot),
        );
        headerAt = at;
      } catch {
        /* Unused slots have random bytes. */
      }
    }
    expect(headerAt).toBeGreaterThanOrEqual(24);
    expect(multiple.subarray(0, 24)).toEqual(single.subarray(0, 24));
    expect(multiple.subarray(headerAt, headerAt + 32)).toEqual(
      single.subarray(headerAt, headerAt + 32),
    );
    const end = 152 + new TextEncoder().encode(primary.text).length + 28;
    expect(multiple.subarray(152, end)).toEqual(single.subarray(152, end));
    expect((await decryptEnvelope(multiple, primary.password)).text).toBe(
      primary.text,
    );
    // This is a structural regression check, not a proof of deniability.
  });

  it("authenticates its own record without authenticating undisclosed later records", async () => {
    const bytes = await encryptEnvelope([primary, more[0]]);
    const primaryLength = new TextEncoder().encode(primary.text).length;
    const secondStart = 152 + primaryLength + 28;
    const damagedSecond = bytes.slice();
    damagedSecond[secondStart + 12] ^= 1;
    expect((await decryptEnvelope(damagedSecond, primary.password)).text).toBe(
      primary.text,
    );
    await expect(
      decryptEnvelope(damagedSecond, more[0].password),
    ).rejects.toThrow();
    const damagedFirst = bytes.slice();
    damagedFirst[152 + 12] ^= 1;
    await expect(
      decryptEnvelope(damagedFirst, primary.password),
    ).rejects.toThrow();
    expect((await decryptEnvelope(damagedFirst, more[0].password)).text).toBe(
      more[0].text,
    );
    const damagedFiller = bytes.slice();
    damagedFiller[BACKUP_BYTES - 1] ^= 1;
    expect((await decryptEnvelope(damagedFiller, primary.password)).text).toBe(
      primary.text,
    );
  });

  it("rejects malformed structure and old-format input", async () => {
    const bytes = await encryptWithRandom([primary], fixtureRandom());
    for (const offset of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const malformed = bytes.slice();
      malformed[offset] ^= 0xff;
      expect(() => parseEnvelope(malformed)).toThrow();
      await expect(
        decryptEnvelope(malformed, primary.password),
      ).rejects.toThrow();
    }
    expect(() => parseEnvelope(bytes.subarray(0, bytes.length - 1))).toThrow();
    const oversized = new Uint8Array(bytes.length + 1);
    oversized.set(bytes);
    expect(() => parseEnvelope(oversized)).toThrow();
    const oldMagic = bytes.slice();
    oldMagic.set(new TextEncoder().encode("PWRD"));
    expect(() => parseEnvelope(oldMagic)).toThrow();
  });

  it("rejects authenticated invalid coordinates and malformed authenticated UTF-8", async () => {
    const bytes = await encryptWithRandom([primary], fixtureRandom());
    const { preamble, salt } = parseEnvelope(bytes);
    const keys = await derive(primary.password, salt);
    let occupiedSlot = -1;
    for (let slot = 0; slot < 4; slot++) {
      const at = 24 + slot * 32;
      try {
        await open(
          keys.header,
          bytes.subarray(at, at + 12),
          bytes.subarray(at + 12, at + 32),
          associatedData("H", preamble, salt, slot),
        );
        occupiedSlot = slot;
      } catch {
        /* Unknown slots intentionally fail authentication. */
      }
    }
    expect(occupiedSlot).toBeGreaterThanOrEqual(0);
    for (const [offset, length] of [
      [65535, 1],
      [0, 0],
      [1, 1],
      [28, 1],
      [0, 2679],
      [2700, 1],
    ]) {
      const invalid = bytes.slice();
      const header = new Uint8Array(4);
      const view = new DataView(header.buffer);
      view.setUint16(0, offset, true);
      view.setUint16(2, length, true);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      invalid.set(
        concat(
          nonce,
          await seal(
            keys.header,
            nonce,
            header,
            associatedData("H", preamble, salt, occupiedSlot),
          ),
        ),
        24 + occupiedSlot * 32,
      );
      await expect(
        decryptEnvelope(invalid, primary.password),
      ).rejects.toMatchObject({ code: "auth" });
    }
    const malformed = bytes.slice();
    const header = new Uint8Array([0, 0, 1, 0]);
    const headerNonce = crypto.getRandomValues(new Uint8Array(12));
    const dataNonce = crypto.getRandomValues(new Uint8Array(12));
    malformed.set(
      concat(
        headerNonce,
        await seal(
          keys.header,
          headerNonce,
          header,
          associatedData("H", preamble, salt, occupiedSlot),
        ),
      ),
      24 + occupiedSlot * 32,
    );
    malformed.set(
      concat(
        dataNonce,
        await seal(
          keys.data,
          dataNonce,
          new Uint8Array([0xff]),
          associatedData("D", preamble, salt, occupiedSlot, header),
        ),
      ),
      152,
    );
    await expect(
      decryptEnvelope(malformed, primary.password),
    ).rejects.toMatchObject({ code: "auth" });
  });

  it("rejects two matching headers and directory-slot substitution", async () => {
    const bytes = await encryptWithRandom([primary], fixtureRandom());
    const { preamble, salt } = parseEnvelope(bytes);
    const keys = await derive(primary.password, salt);
    let occupiedSlot = -1;
    let originalHeader: Uint8Array | undefined;
    for (let slot = 0; slot < 4; slot++) {
      const at = 24 + slot * 32;
      try {
        originalHeader = await open(
          keys.header,
          bytes.subarray(at, at + 12),
          bytes.subarray(at + 12, at + 32),
          associatedData("H", preamble, salt, slot),
        );
        occupiedSlot = slot;
      } catch {
        /* Unknown slots intentionally fail authentication. */
      }
    }
    expect(originalHeader).toBeDefined();
    const otherSlot = (occupiedSlot + 1) % 4;
    const ambiguous = bytes.slice();
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    ambiguous.set(
      concat(
        nonce,
        await seal(
          keys.header,
          nonce,
          originalHeader!,
          associatedData("H", preamble, salt, otherSlot),
        ),
      ),
      24 + otherSlot * 32,
    );
    await expect(
      decryptEnvelope(ambiguous, primary.password),
    ).rejects.toMatchObject({ code: "auth" });
    const swapped = bytes.slice();
    const occupiedAt = 24 + occupiedSlot * 32;
    const otherAt = 24 + otherSlot * 32;
    swapped.set(bytes.subarray(otherAt, otherAt + 32), occupiedAt);
    swapped.set(bytes.subarray(occupiedAt, occupiedAt + 32), otherAt);
    await expect(
      decryptEnvelope(swapped, primary.password),
    ).rejects.toMatchObject({ code: "auth" });
  });
});
