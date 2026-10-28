import { argon2id } from "hash-wasm";
import { PaperError } from "./errors";
export const utf8 = new TextEncoder();
export const owned = (bytes: Uint8Array): Uint8Array<ArrayBuffer> =>
  new Uint8Array(bytes);
export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
export function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const value = text.charCodeAt(i);
    if (value >= 0xd800 && value <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (value >= 0xdc00 && value <= 0xdfff) return false;
  }
  return true;
}
export function passwordBytes(password: string): Uint8Array<ArrayBuffer> {
  if (
    typeof password !== "string" ||
    password.length > 4096 ||
    !wellFormed(password)
  )
    throw new PaperError("password");
  const bytes = utf8.encode(password.normalize("NFC"));
  if (bytes.length === 0 || bytes.length > 1024) {
    bytes.fill(0);
    throw new PaperError("password");
  }
  return bytes;
}
export interface Keys {
  header: CryptoKey;
  data: CryptoKey;
}
export async function derive(
  password: string,
  salt: Uint8Array,
): Promise<Keys> {
  if (salt.length !== 16) throw new PaperError("format");
  const bytes = passwordBytes(password);
  let master: Uint8Array | undefined;
  try {
    if (!globalThis.crypto?.subtle || typeof WebAssembly === "undefined")
      throw new PaperError("resource");
    try {
      master = await argon2id({
        password: bytes,
        salt,
        parallelism: 1,
        iterations: 3,
        memorySize: 65536,
        hashLength: 32,
        outputType: "binary",
      });
      const material = await crypto.subtle.importKey(
        "raw",
        owned(master),
        "HKDF",
        false,
        ["deriveKey"],
      );
      const key = (label: string) =>
        crypto.subtle.deriveKey(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: owned(salt),
            info: utf8.encode(label),
          },
          material,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
      return {
        header: await key("paperwarden-next/v1/header"),
        data: await key("paperwarden-next/v1/data"),
      };
    } catch (error) {
      if (error instanceof PaperError) throw error;
      throw new PaperError("resource");
    }
  } finally {
    bytes.fill(0);
    master?.fill(0);
  }
}
export async function seal(
  key: CryptoKey,
  nonce: Uint8Array,
  plain: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: owned(nonce),
        additionalData: owned(aad),
        tagLength: 128,
      },
      key,
      owned(plain),
    ),
  );
}
export async function open(
  key: CryptoKey,
  nonce: Uint8Array,
  cipher: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: owned(nonce),
        additionalData: owned(aad),
        tagLength: 128,
      },
      key,
      owned(cipher),
    ),
  );
}
export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
export async function fingerprint(bytes: Uint8Array): Promise<string> {
  return hex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", owned(bytes))),
  );
}
