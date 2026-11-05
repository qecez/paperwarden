import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generatePassphrase,
  PASSPHRASE_WORD_COUNT,
} from "../src/app/passphrase";
import words from "../src/encoding/wordlists/bip39-english.json";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("independent local password generation", () => {
  it("uses eight uniform choices from 2,048 distinct words, for 88 bits", () => {
    expect(words).toHaveLength(2048);
    expect(new Set(words).size).toBe(2048);
    expect(PASSPHRASE_WORD_COUNT).toBe(8);
    expect(PASSPHRASE_WORD_COUNT * Math.log2(words.length)).toBe(88);

    // Exhaust the input domain, including values above the word-table length.
    // Every word must have exactly 32 preimages among the 65,536 Uint16 values.
    let next = 0;
    const random = vi
      .spyOn(crypto, "getRandomValues")
      .mockImplementation((buffer) => {
        expect(buffer).toBeInstanceOf(Uint16Array);
        expect(buffer!.byteLength).toBe(16);
        const values = buffer as Uint16Array;
        for (let index = 0; index < values.length; index++)
          values[index] = next++;
        return buffer;
      });
    const counts = new Map(words.map((word) => [word, 0]));
    for (let offset = 0; offset < 65536; offset += PASSPHRASE_WORD_COUNT) {
      const phrase = generatePassphrase();
      expect(phrase).toMatch(/^[a-z]+(?: [a-z]+){7}$/);
      for (const word of phrase.split(" "))
        counts.set(word, counts.get(word)! + 1);
    }
    expect(random).toHaveBeenCalledTimes(
      Math.ceil(65536 / PASSPHRASE_WORD_COUNT),
    );
    expect([...counts.values()].every((count) => count === 32)).toBe(true);
  });

  it("makes fresh independent draws and clears temporary random buffers", () => {
    const buffers: Uint16Array[] = [];
    vi.spyOn(crypto, "getRandomValues").mockImplementation((buffer) => {
      const values = buffer as Uint16Array;
      buffers.push(values);
      values.fill(buffers.length - 1);
      return buffer;
    });
    expect(generatePassphrase()).toBe(Array(8).fill("abandon").join(" "));
    expect(generatePassphrase()).toBe(Array(8).fill("ability").join(" "));
    expect(buffers).toHaveLength(2);
    expect(buffers[0]).not.toBe(buffers[1]);
    expect(
      buffers.every((buffer) => buffer.every((value) => value === 0)),
    ).toBe(true);
  });

  it("fails without a CSPRNG and never falls back to Math.random", () => {
    const weakRandom = vi.spyOn(Math, "random");
    vi.stubGlobal("crypto", undefined);
    expect(() => generatePassphrase()).toThrow();
    expect(weakRandom).not.toHaveBeenCalled();
  });

  it("propagates CSPRNG failure and clears even a partially filled buffer", () => {
    let random: Uint16Array | undefined;
    const failure = new Error("public simulated entropy failure");
    vi.spyOn(crypto, "getRandomValues").mockImplementation((buffer) => {
      random = buffer as Uint16Array;
      random.fill(65535);
      throw failure;
    });
    expect(() => generatePassphrase()).toThrow(failure);
    expect(random).toEqual(new Uint16Array(8));
  });
});
