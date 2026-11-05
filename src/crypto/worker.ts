import {
  decryptEnvelope,
  encryptEnvelope,
  type SecretInput,
} from "../format/envelope";
import { PaperError } from "./errors";
export type CryptoJob =
  | { kind: "encrypt"; messages: SecretInput[] }
  | { kind: "decrypt"; container: Uint8Array; password: string };
self.onmessage = async (event: MessageEvent<CryptoJob>) => {
  try {
    const job = event.data;
    if (job?.kind === "encrypt") {
      const bytes = await encryptEnvelope(job.messages);
      // Check the actual completed envelope through the reader before allowing printing.
      for (const message of job.messages) {
        if (
          (await decryptEnvelope(bytes, message.password)).text !== message.text
        )
          throw new PaperError("auth");
      }
      self.postMessage(
        { ok: true, value: bytes },
        { transfer: [bytes.buffer] },
      );
    } else if (job?.kind === "decrypt") {
      self.postMessage({
        ok: true,
        value: await decryptEnvelope(job.container, job.password),
      });
    } else throw new PaperError("format");
  } catch (error) {
    self.postMessage({
      ok: false,
      code: error instanceof PaperError ? error.code : "resource",
    });
  }
};
