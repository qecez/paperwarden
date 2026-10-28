import { expect, it } from "vitest";
import reference from "./fixtures/reference.json";
import { decryptEnvelope, encryptWithRandom } from "../src/format/envelope";
import { fingerprint } from "../src/crypto/primitives";

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

it("decrypts every message in the independent reference envelope", async () => {
  const bytes = new Uint8Array(Buffer.from(reference.hex, "hex"));
  for (const message of reference.messages) {
    expect(await decryptEnvelope(bytes, message.password)).toEqual({
      text: message.text,
    });
  }
  await expect(
    decryptEnvelope(bytes, "not a reference password"),
  ).rejects.toMatchObject({ code: "auth" });
});
