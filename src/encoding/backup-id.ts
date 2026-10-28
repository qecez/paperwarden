import words from "./wordlists/bip39-english.json" with { type: "json" };

/**
 * Display the first 64 SHA-256 bits as six fixed-table words. This is a public
 * comparison identifier, not a BIP39 mnemonic, password, or recovery phrase.
 * Table provenance and the exact stable encoding are documented in FORMAT.md.
 */
export function formatBackupId(digest: string): string {
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/i.test(digest))
    throw new TypeError("Expected a 64-character SHA-256 hexadecimal digest.");
  let value = BigInt(`0x${digest.slice(0, 16)}`);
  const result = new Array<string>(6);
  for (let index = result.length - 1; index >= 0; index--) {
    result[index] = words[Number(value & 2047n)];
    value >>= 11n;
  }
  return result.join(" ");
}
