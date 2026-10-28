import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import pages from "./fixtures/qr-pages/pages.json";
import { BACKUP_BYTES } from "../src/format/constants";
import {
  decodeBase45,
  decodeTransport,
  encodeBase45,
  encodeTransport,
  TRANSPORT_CHARACTERS,
} from "../src/encoding/transport";
import {
  ARCHIVE_LINES,
  decodeArchive,
  decodeBase32,
  encodeArchive,
  encodeBase32,
  MAX_ARCHIVE_CHARACTERS,
} from "../src/encoding/archive";
import {
  QR_QUIET_ZONE,
  qrMatrix,
  qrSvg,
  scanPixels,
  type QrOptions,
} from "../src/encoding/qr";
import { encodeLink } from "../src/encoding/link";

// Public, structurally valid envelopes. Payload bytes are not encrypted messages.
function specimen(): Uint8Array {
  const bytes = crypto.getRandomValues(new Uint8Array(BACKUP_BYTES));
  bytes.set([0x50, 0x57, 0x4e, 0x58, 1, 1, 0, 0]);
  return bytes;
}

function raster(
  bytes: Uint8Array,
  scale: number,
  offsetX = 0,
  offsetY = 0,
  options: QrOptions = {},
) {
  const { modules } = qrMatrix(bytes, options);
  const width = Math.ceil(
    (modules.size + 2 * QR_QUIET_ZONE) * scale + 2 * offsetX,
  );
  const height = Math.ceil(
    (modules.size + 2 * QR_QUIET_ZONE) * scale + 2 * offsetY,
  );
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++) {
    const moduleY = Math.floor((y + 0.5 - offsetY) / scale) - QR_QUIET_ZONE;
    if (moduleY < 0 || moduleY >= modules.size) continue;
    for (let x = 0; x < width; x++) {
      const moduleX = Math.floor((x + 0.5 - offsetX) / scale) - QR_QUIET_ZONE;
      if (
        moduleX < 0 ||
        moduleX >= modules.size ||
        !modules.get(moduleY, moduleX)
      )
        continue;
      const pixel = (y * width + x) * 4;
      pixels[pixel] = pixels[pixel + 1] = pixels[pixel + 2] = 0;
    }
  }
  return { pixels, width, height };
}

describe("Base45 and the fixed QR transport", () => {
  it("matches independent RFC 9285 examples, including meaningful spaces", () => {
    for (const [plain, encoded] of [
      ["AB", "BB8"],
      ["Hello!!", "%69 VD92EX0"],
      ["base-45", "UJCLQE7W581"],
    ]) {
      const bytes = new TextEncoder().encode(plain);
      expect(encodeBase45(bytes)).toBe(encoded);
      expect(decodeBase45(encoded)).toEqual(bytes);
    }
  });

  it("round trips every byte value and odd-length input", () => {
    const everyByte = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(decodeBase45(encodeBase45(everyByte))).toEqual(everyByte);
    const odd = Uint8Array.from([...everyByte, 255]);
    expect(decodeBase45(encodeBase45(odd))).toEqual(odd);
  });

  it("rejects invalid digits, overflow, impossible lengths, and oversized input", () => {
    for (const input of [
      "a",
      "0000",
      "ZZ",
      ":::",
      "0\n",
      "a0",
      "000".repeat(BACKUP_BYTES),
    ]) {
      expect(() => decodeBase45(input)).toThrow();
    }
    expect(() => encodeBase45(new Uint8Array(BACKUP_BYTES + 1))).toThrow();
  });

  it("preserves all envelope bytes with a fixed 4,295-character encoding", () => {
    const bytes = specimen();
    const text = encodeTransport(bytes);
    expect(text).toHaveLength(4295);
    expect(TRANSPORT_CHARACTERS).toBe(4295);
    expect(text.startsWith("PWN:")).toBe(true);
    expect(text.endsWith(":END")).toBe(true);
    expect(decodeTransport(text)).toEqual(bytes);
    for (const changed of [
      ` ${text}`,
      `${text}\n`,
      text.toLowerCase(),
      text.replace(/^PWN/, "PW1"),
      text.slice(0, -1),
    ]) {
      expect(() => decodeTransport(changed)).toThrow();
    }
    const badPreamble = bytes.slice();
    badPreamble[4] = 2;
    expect(() =>
      decodeTransport(`PWN:${encodeBase45(badPreamble)}:END`),
    ).toThrow();
  });
});

describe("archival written recovery", () => {
  it("uses canonical Base32 including unused final bits", () => {
    for (let count = 0; count <= 11; count++) {
      const bytes = crypto.getRandomValues(new Uint8Array(count));
      expect(decodeBase32(encodeBase32(bytes))).toEqual(bytes);
    }
    expect(encodeBase32(new Uint8Array([255]))).toBe("ZW");
    expect(() => decodeBase32("ZX")).toThrow();
    for (const bad of ["0", "I0", "O0", "00=", "zw"])
      expect(() => decodeBase32(bad)).toThrow();
  });

  it("recovers all 115 numbered lines and tolerates presentation whitespace", async () => {
    const bytes = specimen();
    const text = await encodeArchive(bytes);
    expect(ARCHIVE_LINES).toBe(115);
    expect(text.split("\n")).toHaveLength(117);
    expect(text.length).toBeLessThan(MAX_ARCHIVE_CHARACTERS);
    expect(await decodeArchive(text)).toEqual(bytes);
    expect(
      await decodeArchive(
        `\n  ${text.replaceAll(" ", "  ").replaceAll("PWN-1  ARCHIVE", "PWN-1 ARCHIVE").replaceAll("\n", " \r\n  ")} \r\n`,
      ),
    ).toEqual(bytes);
  });

  it("rejects corruption, deletion, duplicate lines, reordering, and mismatched fingerprint", async () => {
    const text = await encodeArchive(specimen());
    const lines = text.split("\n");
    const reordered = lines.slice();
    [reordered[2], reordered[3]] = [reordered[3], reordered[2]];
    const duplicate = lines.slice();
    duplicate[3] = duplicate[2];
    const corrupt = lines.slice();
    corrupt[2] = corrupt[2].replace(
      /^(001 )([0-9A-Z])/,
      (_, prefix: string, char: string) => prefix + (char === "0" ? "1" : "0"),
    );
    for (const changed of [
      lines.slice(0, -1).join("\n"),
      reordered.join("\n"),
      duplicate.join("\n"),
      corrupt.join("\n"),
      text.replace(/SHA256 ./, "SHA256 z"),
      text.replace(
        /SHA256 ([0-9a-f])/,
        (_, char: string) => `SHA256 ${char === "0" ? "1" : "0"}`,
      ),
      "x".repeat(MAX_ARCHIVE_CHARACTERS + 1),
    ]) {
      await expect(decodeArchive(changed)).rejects.toThrow();
    }
  });
});

describe("fixed QR generation and decoding", () => {
  it("supports explicit raw mode with one alphanumeric segment and a four-module quiet zone", () => {
    const bytes = specimen();
    const matrix = qrMatrix(bytes, { includeLink: false });
    expect(matrix.version).toBe(40);
    expect(matrix.errorCorrectionLevel.bit).toBe(1);
    expect(matrix.modules.size).toBe(177);
    expect(matrix.segments).toHaveLength(1);
    expect(matrix.segments[0].mode.id).toBe("Alphanumeric");
    const svg = qrSvg(bytes, { includeLink: false });
    expect(svg).toContain('viewBox="0 0 185 185"');
    expect(svg).toContain('fill="white"');
    expect(svg).not.toMatch(/(?:href|src)=/);
  });

  it("defaults to a linked QR with full capacity, fixed dimensions and mixed segments", () => {
    const bytes = specimen();
    const matrix = qrMatrix(bytes);
    expect(matrix.version).toBe(40);
    expect(matrix.errorCorrectionLevel.bit).toBe(1);
    expect(matrix.modules.size).toBe(177);
    expect(
      matrix.segments.map((segment) => [segment.mode.id, segment.getLength()]),
    ).toEqual([
      ["Byte", 30],
      ["Alphanumeric", 4219],
    ]);
    expect(
      matrix.segments[0].getBitsLength() +
        matrix.segments[1].getBitsLength() +
        20 +
        17,
    ).toBe(23482);
    const encodedText = matrix.segments
      .map((segment) =>
        typeof segment.data === "string"
          ? segment.data
          : new TextDecoder().decode(segment.data),
      )
      .join("");
    expect(encodedText).toBe(encodeLink(bytes));
    const svg = qrSvg(bytes);
    expect(svg).toContain('viewBox="0 0 185 185"');
    expect(svg).not.toMatch(/(?:href|src)=/);
  });

  it.each([false, true])(
    "recovers full high-entropy envelopes at different scales and alignments (linked: %s)",
    (includeLink) => {
      for (const [scale, offsetX, offsetY] of [
        [3, 0, 0],
        [5, 2, 1],
        [7, 1, 3],
      ]) {
        const bytes = specimen();
        const { pixels, width, height } = raster(
          bytes,
          scale,
          offsetX,
          offsetY,
          { includeLink },
        );
        expect(scanPixels(pixels, width, height)).toEqual(bytes);
      }
    },
  );

  // Linux Chromium/Poppler output from CI run 40496290099, public messages and
  // passwords only. These are complete pages, stored losslessly as gzip luma.
  it.each(pages)("recovers the captured CI whole-page raster $file", (page) => {
    const gray = gunzipSync(
      readFileSync(
        new URL(`./fixtures/qr-pages/${page.file}`, import.meta.url),
      ),
    );
    expect(gray.length).toBe(page.width * page.height);
    const pixels = new Uint8ClampedArray(gray.length * 4).fill(255);
    for (let i = 0; i < gray.length; i++)
      pixels[i * 4] = pixels[i * 4 + 1] = pixels[i * 4 + 2] = gray[i];
    const bytes = scanPixels(pixels, page.width, page.height);
    expect(bytes).not.toBeNull();
    // Expected digest was independently extracted from the PDF's written copy.
    expect(createHash("sha256").update(bytes!).digest("hex")).toBe(
      page.envelopeSha256,
    );
  });

  it.each([
    [0x12345678, 3.25, 70.3, 110.7],
    [0xcafebabe, 4.9, 95.1, 120.25],
    [0x89abcdef, 5.989, 85.75, 140.1],
    [0x1a2b3c4d, 6.375, 100.2, 130.8],
  ])(
    "recovers deterministic dense page data with seed %i at fractional scale %f",
    (seed, scale, x, y) => {
      // Reproducible public test data, never used for encryption randomness.
      let state = seed;
      const bytes = Uint8Array.from({ length: BACKUP_BYTES }, () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state & 255;
      });
      bytes.set([0x50, 0x57, 0x4e, 0x58, 1, 1, 0, 0]);
      const { pixels, width, height } = raster(bytes, scale, x, y, {
        includeLink: false,
      });
      // Page furniture prevents treating the entire image as an isolated QR.
      for (let row = 12; row < 20; row++)
        for (let col = 10; col < 150; col++) {
          const offset = (row * width + col) * 4;
          pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
        }
      expect(scanPixels(pixels, width, height)).toEqual(bytes);
    },
  );

  it("returns no match for a blank image and rejects invalid dimensions before allocation", () => {
    expect(
      scanPixels(new Uint8ClampedArray(200 * 200 * 4).fill(255), 200, 200),
    ).toBeNull();
    for (const [width, height] of [
      [-1, 10],
      [0, 0],
      [100.5, 100],
      [2401, 1],
      [10, 10],
    ]) {
      expect(() =>
        scanPixels(new Uint8ClampedArray(0), width, height),
      ).toThrow();
    }
  });
});
