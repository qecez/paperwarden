import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { BACKUP_BYTES, PREAMBLE } from "../src/format/constants";
import {
  decodeLink,
  decodeLinkFragment,
  decodeQrPayload,
  encodeLink,
  LINK_FRAGMENT_MARKER,
  LINK_SUFFIX,
  LINK_PAYLOAD_CHARACTERS,
  MAX_LINK_PREFIX_CHARACTERS,
  READER_URL,
} from "../src/encoding/link";
import {
  encodeRadix42,
  decodeRadix42,
  RADIX42_ALPHABET,
  RADIX42_CHARACTERS,
} from "../src/encoding/radix42";
import linkReference from "./fixtures/link-reference.json";
import { encodeTransport } from "../src/encoding/transport";
import reference from "./fixtures/reference.json";

function specimen(): Uint8Array {
  const bytes = crypto.getRandomValues(new Uint8Array(BACKUP_BYTES));
  bytes.set(PREAMBLE);
  return bytes;
}

describe("fixed-width radix42 link transport", () => {
  it("matches the independent Python envelope and complete URL", () => {
    const bytes = new Uint8Array(Buffer.from(reference.hex, "hex"));
    expect(RADIX42_ALPHABET).toBe(linkReference.alphabet);
    expect(encodeRadix42(bytes)).toBe(linkReference.encodedPayload);
    expect(decodeRadix42(linkReference.encodedPayload)).toEqual(bytes);
    expect(encodeLink(bytes)).toBe(linkReference.url);
    expect(decodeLinkFragment(new URL(linkReference.url).hash)).toEqual(bytes);
    expect(decodeLink(linkReference.url)).toEqual(bytes);
  });

  it.each(linkReference.blockVectors)(
    "matches independent block vector $name",
    (vector) => {
      const block = new Uint8Array(Buffer.from(vector.hex, "hex"));
      const bytes = new Uint8Array(BACKUP_BYTES);
      const offset = block.length === 31 ? 0 : BACKUP_BYTES - 6;
      const position = block.length === 31 ? 0 : RADIX42_CHARACTERS - 9;
      bytes.set(block, offset);
      const encoded = encodeRadix42(bytes);
      expect(encoded.slice(position, position + vector.encoded.length)).toBe(
        vector.encoded,
      );
      const independent =
        "0".repeat(position) +
        vector.encoded +
        "0".repeat(RADIX42_CHARACTERS - position - vector.encoded.length);
      expect(decodeRadix42(independent)).toEqual(bytes);
    },
  );

  it("preserves all-zero, all-FF and random bytes with one exact length", () => {
    for (const bytes of [
      new Uint8Array(BACKUP_BYTES),
      new Uint8Array(BACKUP_BYTES).fill(255),
      crypto.getRandomValues(new Uint8Array(BACKUP_BYTES)),
    ]) {
      const encoded = encodeRadix42(bytes);
      expect(encoded).toHaveLength(4241);
      expect(decodeRadix42(encoded)).toEqual(bytes);
    }
    expect(encodeRadix42(new Uint8Array(BACKUP_BYTES))).toBe("0".repeat(4241));
  });

  it.each(linkReference.invalidBlockVectors)(
    "rejects noncanonical block $name",
    (vector) => {
      const position = vector.byteLength === 31 ? 0 : RADIX42_CHARACTERS - 9;
      const text =
        "0".repeat(position) +
        vector.encoded +
        "0".repeat(RADIX42_CHARACTERS - position - vector.encoded.length);
      expect(() => decodeRadix42(text)).toThrow("format");
    },
  );

  it("rejects missing or extra data and disallowed alphabet characters", () => {
    for (const size of [0, BACKUP_BYTES - 1, BACKUP_BYTES + 1])
      expect(() => encodeRadix42(new Uint8Array(size))).toThrow("format");
    for (const text of [
      "",
      "0".repeat(4240),
      "0".repeat(4242),
      "0".repeat(4240) + "\n",
      "0".repeat(4240) + "#",
      "0".repeat(4240) + "é",
      "0".repeat(4240) + "_",
      "0".repeat(4240) + ".",
    ])
      expect(() => decodeRadix42(text)).toThrow("format");
  });
});

describe("strict HTTPS link handling", () => {
  it("decodes fragments, raw transport and other HTTPS hosts without changing bytes", () => {
    const bytes = specimen();
    const link = encodeLink(bytes);
    expect(link).toHaveLength(4272);
    expect(link.startsWith("https://paperwarden.com/#PWN1:")).toBe(true);
    expect(decodeLinkFragment(new URL(link).hash)).toEqual(bytes);
    expect(decodeQrPayload(link)).toEqual(bytes);
    expect(decodeQrPayload(encodeTransport(bytes))).toEqual(bytes);
    const elsewhere = encodeLink(bytes, "https://offline.example/");
    expect(decodeLink(elsewhere)).toEqual(bytes);
    expect(new URL(elsewhere).href).toBe(elsewhere);
    expect(encodeLink(bytes, "https://PAPERWARDEN.COM")).toBe(link);
  });

  it("bounds the complete prefix by the actual version-40/L QR capacity", () => {
    const bytes = specimen();
    const base =
      READER_URL +
      "x".repeat(
        MAX_LINK_PREFIX_CHARACTERS -
          READER_URL.length -
          LINK_FRAGMENT_MARKER.length,
      );
    const link = encodeLink(bytes, base);
    expect(link.length - LINK_PAYLOAD_CHARACTERS).toBe(35);
    const qr = QRCode.create(
      [
        { data: new TextEncoder().encode(link.slice(0, 35)), mode: "byte" },
        { data: link.slice(35), mode: "alphanumeric" },
      ],
      { version: 40, errorCorrectionLevel: "L" },
    );
    expect(qr.version).toBe(40);
    expect(qr.modules.size).toBe(177);
    expect(qr.segments.map((segment) => segment.mode.id)).toEqual([
      "Byte",
      "Alphanumeric",
    ]);
    expect(() => encodeLink(bytes, base + "x")).toThrow("format");
    expect(() =>
      QRCode.create(
        [
          {
            data: new TextEncoder().encode(base + "x" + LINK_FRAGMENT_MARKER),
            mode: "byte",
          },
          { data: encodeRadix42(bytes) + LINK_SUFFIX, mode: "alphanumeric" },
        ],
        { version: 40, errorCorrectionLevel: "L" },
      ),
    ).toThrow();
  });

  it("rejects ambiguous, noncanonical and non-HTTPS link prefixes", () => {
    const bytes = specimen();
    const fragment =
      LINK_FRAGMENT_MARKER + (encodeRadix42(bytes) + LINK_SUFFIX);
    for (const base of [
      "http://paperwarden.com/",
      "javascript:alert(1)",
      "//paperwarden.com/",
      "https:paperwarden.com/",
      "https:///paperwarden.com/",
      "https:////paperwarden.com/",
      "https://user:pass@paperwarden.com/",
      "https://@paperwarden.com/",
      "https://paperwarden.com/?track=1",
      "https://paperwarden.com/?",
      "https://paperwarden.com/%2f",
      "https://paperwarden.com/\\",
      "https://paperwarden.com/\n",
      "https://paperwarden.com/ ",
      "https://paperwarden.com/é",
      'https://paperwarden.com/"',
      "https://paperwarden.com/#other",
    ]) {
      expect(() => encodeLink(bytes, base), base).toThrow("format");
      expect(() => decodeLink(base + fragment), base).toThrow("format");
    }
    for (const base of [
      "HTTPS://paperwarden.com/",
      "https://PAPERWARDEN.COM/",
      "https://paperwarden.com",
      "https://paperwarden.com:443/",
      "https://paperwarden.com/a/../",
    ])
      expect(() => decodeLink(base + fragment), base).toThrow("format");
  });

  it("rejects unsupported markers, percent escapes, missing data and bad envelope headers", () => {
    const bytes = specimen();
    const link = encodeLink(bytes);
    for (const changed of [
      link.replace("#PWN1:", "#PWN3:"),
      link.replace("#PWN1:", "#pwn1:"),
      link.replace("#PWN1:", "#PWN01:"),
      link.replace("#PWN1:", "#PWN1%3A"),
      link + "\n",
      " " + link,
      link.slice(0, -1),
      link + "0",
      link.slice(0, -1) + "B",
      link.slice(0, -1) + ".",
      link.slice(0, -1) + "%30",
      link.slice(0, -1) + "#",
      link.toLowerCase(),
    ])
      expect(() => decodeLink(changed)).toThrow();
    expect(() =>
      decodeLinkFragment("PWN1:" + (encodeRadix42(bytes) + LINK_SUFFIX)),
    ).toThrow();
    bytes[4] = 2;
    expect(() => encodeLink(bytes)).toThrow("version");
    expect(() =>
      decodeLink(
        READER_URL +
          LINK_FRAGMENT_MARKER +
          (encodeRadix42(bytes) + LINK_SUFFIX),
      ),
    ).toThrow("version");
    expect(() =>
      decodeLink(
        READER_URL + LINK_FRAGMENT_MARKER + "0".repeat(4241) + LINK_SUFFIX,
      ),
    ).toThrow("format");
  });
});

it("preserves random backups in a period-free, fixed-length link", () => {
  for (let i = 0; i < 100; i++) {
    const bytes = specimen();
    const link = encodeLink(bytes);
    expect(new URL(link).hash).toMatch(/^#PWN1:[0-9A-Z$*+/:-]{4241}A$/);
    expect(decodeLink(link)).toEqual(bytes);
  }
});
