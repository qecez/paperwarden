import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { formatBackupId } from "../src/encoding/backup-id";
import words from "../src/encoding/wordlists/bip39-english.json";
import reference from "./fixtures/reference.json";

const tail = "0".repeat(48);

describe("six-word Backup ID", () => {
  it("pins the complete ordered upstream word table", () => {
    expect(words).toHaveLength(2048);
    expect(new Set(words).size).toBe(2048);
    expect(words.every((word) => /^[a-z]+$/.test(word))).toBe(true);
    // Hash the upstream UTF-8/LF file representation, including its final LF.
    expect(
      createHash("sha256")
        .update(words.join("\n") + "\n")
        .digest("hex"),
    ).toBe("2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda");
  });

  it.each([
    ["0000000000000000", "abandon abandon abandon abandon abandon abandon"],
    ["0000000000000001", "abandon abandon abandon abandon abandon ability"],
    ["0000000000000800", "abandon abandon abandon abandon ability abandon"],
    ["8000000000000000", "cactus abandon abandon abandon abandon abandon"],
    ["ffffffffffffffff", "divide zoo zoo zoo zoo zoo"],
  ])(
    "preserves fixed width and big-endian ordering for %s",
    (prefix, expected) => {
      expect(formatBackupId(prefix + tail)).toBe(expected);
    },
  );

  it("matches an independently calculated identifier for the public envelope", () => {
    const digest = createHash("sha256")
      .update(Buffer.from(reference.hex, "hex"))
      .digest("hex");
    expect(digest).toBe(reference.sha256);
    // Calculated independently with Python: binary64 padded to 66 bits, then
    // six left-to-right 11-bit indices [291,1011,1753,595,1311,1754].
    expect(formatBackupId(digest)).toBe(
      "caught lazy swamp engine physical swap",
    );
  });

  it("retains all 64 identifier bits, including every single-bit position", () => {
    const prefixes = [0n, (1n << 64n) - 1n];
    for (let bit = 0n; bit < 64n; bit++) prefixes.push(1n << bit);
    for (const value of prefixes) {
      const digest = value.toString(16).padStart(16, "0") + tail;
      const identifiers = formatBackupId(digest).split(" ");
      expect(identifiers).toHaveLength(6);
      const indices = identifiers.map((word) => words.indexOf(word));
      expect(indices.every((index) => index >= 0 && index < 2048)).toBe(true);
      expect(indices[0]).toBeLessThan(512);
      const recovered = indices.reduce(
        (total, index) => total * 2048n + BigInt(index),
        0n,
      );
      expect(recovered).toBe(value);
    }
  });

  it("uses only the first 64 digest bits and accepts hexadecimal letter case", () => {
    expect(formatBackupId(reference.sha256.toUpperCase())).toBe(
      formatBackupId(reference.sha256),
    );
    expect(formatBackupId(reference.sha256.slice(0, 16) + "f".repeat(48))).toBe(
      formatBackupId(reference.sha256),
    );
  });

  it.each([
    "",
    "0".repeat(16),
    "0".repeat(63),
    "0".repeat(65),
    "g" + "0".repeat(63),
    "0".repeat(63) + "g",
    "0x" + "0".repeat(64),
    " " + "0".repeat(64),
    "0".repeat(64) + "\n",
  ])("rejects malformed digest %s", (digest) => {
    expect(() => formatBackupId(digest)).toThrow(TypeError);
  });
});
