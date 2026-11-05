import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCrypto } from "../src/crypto/client";

const source = "/* public worker source for resource-lifetime tests */";
const job = {
  kind: "decrypt" as const,
  container: new Uint8Array(),
  password: "public test password",
};

beforeEach(() => {
  vi.stubGlobal("document", {
    getElementById: () => ({ textContent: source }),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps the worker source readable during deferred loading, then revokes it", async () => {
  let workerUrl = "";
  const terminate = vi.fn();
  class DeferredWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: { preventDefault(): void }) => void) | null = null;
    onmessageerror = null;
    terminate = terminate;
    constructor(url: string) {
      workerUrl = url;
    }
    postMessage() {
      // A Worker constructor need not finish loading its Blob before returning.
      // Fetching on the next microtask reproduces that lifetime requirement.
      void Promise.resolve().then(async () => {
        try {
          const text = await (await fetch(workerUrl)).text();
          this.onmessage?.({
            data: { ok: true, value: text },
          } as MessageEvent);
        } catch {
          this.onerror?.({ preventDefault() {} });
        }
      });
    }
  }
  vi.stubGlobal("Worker", DeferredWorker);
  expect(await runCrypto(job)).toBe(source);
  expect(terminate).toHaveBeenCalledOnce();
  await expect(fetch(workerUrl)).rejects.toThrow();
});

it("releases the worker and its source when an operation is cancelled", async () => {
  let workerUrl = "";
  const terminate = vi.fn();
  class PendingWorker {
    terminate = terminate;
    constructor(url: string) {
      workerUrl = url;
    }
    postMessage() {}
  }
  vi.stubGlobal("Worker", PendingWorker);
  const controller = new AbortController();
  const operation = runCrypto(job, { signal: controller.signal });
  const rejected = expect(operation).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(await (await fetch(workerUrl)).text()).toBe(source);
  controller.abort();
  await rejected;
  expect(terminate).toHaveBeenCalledOnce();
  await expect(fetch(workerUrl)).rejects.toThrow();
});

it("revokes the source even if the browser rejects worker construction", async () => {
  let workerUrl = "";
  class UnavailableWorker {
    constructor(url: string) {
      workerUrl = url;
      throw new Error("Public test: worker unavailable");
    }
  }
  vi.stubGlobal("Worker", UnavailableWorker);
  await expect(runCrypto(job)).rejects.toMatchObject({ code: "resource" });
  await expect(fetch(workerUrl)).rejects.toThrow();
});
