import type { CryptoJob } from "./worker";
import { isErrorCode, PaperError } from "./errors";
/** One short-lived worker per operation; terminating it also bounds cancellation and hung jobs. */
export function runCrypto<T>(
  job: CryptoJob,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const { signal } = options;
    if (signal?.aborted) {
      reject(new DOMException("Operation cancelled", "AbortError"));
      return;
    }
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (worker) {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
      }
    };
    const fail = (error: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
    };
    const abort = () =>
      fail(new DOMException("Operation cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const source = document.getElementById("crypto-worker")?.textContent;
      if (
        !source ||
        !globalThis.crypto?.subtle ||
        typeof Worker === "undefined" ||
        typeof WebAssembly === "undefined"
      )
        throw new PaperError("resource");
      const url = URL.createObjectURL(
        new Blob([source], { type: "text/javascript" }),
      );
      try {
        worker = new Worker(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      worker.onmessage = (event: MessageEvent) => {
        if (done) return;
        const response = event.data;
        if (response?.ok !== true) {
          fail(
            new PaperError(
              isErrorCode(response?.code) ? response.code : "resource",
            ),
          );
          return;
        }
        done = true;
        cleanup();
        resolve(response.value as T);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        fail(new PaperError("resource"));
      };
      worker.onmessageerror = () => fail(new PaperError("resource"));
      timer = setTimeout(() => fail(new PaperError("resource")), 120000);
      worker.postMessage(job);
    } catch {
      fail(new PaperError("resource"));
    }
  });
}
