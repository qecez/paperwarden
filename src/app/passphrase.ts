import words from "../encoding/wordlists/bip39-english.json" with { type: "json" };

export const PASSPHRASE_WORD_COUNT = 8;

/** Eight independent 11-bit word choices: 88 bits before any user edits. */
export function generatePassphrase(): string {
  const random = new Uint16Array(PASSPHRASE_WORD_COUNT);
  try {
    // A missing or failing CSPRNG must stop generation, never weaken it.
    globalThis.crypto.getRandomValues(random);
    // 2,048 divides the 65,536 possible Uint16 values exactly: no modulo bias.
    return Array.from(random, (value) => words[value & 0x7ff]).join(" ");
  } finally {
    random.fill(0);
  }
}
