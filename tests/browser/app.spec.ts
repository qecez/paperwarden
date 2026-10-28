import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { encryptEnvelope } from "../../src/format/envelope";
import { encodeArchive } from "../../src/encoding/archive";
import { decodeTransport, encodeTransport } from "../../src/encoding/transport";
import {
  BACKUP_BYTES,
  MAX_MESSAGES,
  MAX_TEXT_BYTES,
  maximumTextBytes,
} from "../../src/format/constants";

const messages = [
  {
    text: "Main public test message 🌿\nKeep these spaces  ",
    password: "public river maple stone 1",
  },
  {
    text: "Second public test message.\nCafé",
    password: "public river maple stone 2",
  },
  {
    text: "Third public test message.\n保持",
    password: "public river maple stone 3",
  },
  {
    text: "\uFEFFFourth public test message.",
    password: "public river maple stone 4",
  },
];

async function enterMessages(page: Page, count = 1) {
  for (let index = 0; index < count; index++) {
    if (index) await page.locator("#add-message").click();
    const group = page.locator("[data-message]").nth(index);
    await group.locator("[data-text]").fill(messages[index].text);
    await group.locator("[data-password]").fill(messages[index].password);
  }
}
async function generate(page: Page) {
  await page.locator("#encrypt-button").click();
  await expect(page.locator("#backup-result")).toBeVisible();
  await expect(page.locator("#main")).toHaveAttribute("aria-busy", "false");
}
async function recover(page: Page, password: string, text: string) {
  await page.locator("#open-password").fill(password);
  await page.locator("#open-button").click();
  await expect(page.locator("#recovered")).toBeVisible();
  expect(await page.locator("#recovered-text").textContent()).toBe(text);
  await expect(page.locator("#open-password")).toHaveValue("");
}
async function loadText(page: Page, text: string) {
  await page.locator("#paste").click();
  await page.locator("#encoded").fill(text);
  await page.getByRole("button", { name: "Load backup", exact: true }).click();
  await expect(page.locator("#decrypt-form")).toBeVisible();
  await expect(page.locator("#paste-form")).toBeHidden();
  await expect(page.locator("#input-methods")).toBeVisible();
  await expect(page.locator("#recovered-text")).toHaveText("");
}
async function elementWidth(page: Page, selector: string) {
  return page
    .locator(selector)
    .evaluate((node) => node.getBoundingClientRect().width);
}

test("local password actions keep validation and Enter without a leave-page warning", async ({
  page,
}) => {
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.type());
    await dialog.accept();
  });
  await page.goto("/");
  await page.locator("#password").fill(messages[0].password);
  await page.locator("#password").press("Enter");
  await expect(page.locator("#text")).toBeFocused();
  await expect(page.locator("#backup-result")).toBeHidden();
  await enterMessages(page, 2);
  await page.locator("#text").press("ControlOrMeta+End");
  await page.locator("#text").press("Enter");
  await expect(page.locator("#text")).toHaveValue(messages[0].text + "\n");
  await expect(page.locator("#backup-result")).toBeHidden();
  const passwords = page.locator("[data-password], #open-password");
  expect(
    await passwords.evaluateAll((inputs) =>
      inputs.every(
        (input) =>
          input instanceof HTMLInputElement &&
          input.form === null &&
          input.type === "password" &&
          input.autocomplete === "off",
      ),
    ),
  ).toBe(true);
  await page.locator("[data-password]").last().press("Enter");
  await expect(page.locator("#backup-result")).toBeVisible();
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => page.isClosed()).toBe(true);
  expect(dialogs).toEqual([]);
});

test("one text loader recognizes both backup formats and keeps corruption checks", async ({
  page,
}) => {
  const bytes = await encryptEnvelope(messages.slice(0, 1));
  const transport = encodeTransport(bytes);
  const archive = await encodeArchive(bytes);
  await page.goto("/");
  await page.locator("#decrypt-tab").click();
  for (const text of [transport, `\n  ${archive}\n`]) {
    await loadText(page, text);
    await page.locator("#open-password").press("Enter");
    await expect(page.locator("#recovered")).toBeHidden();
    await page.locator("#open-password").fill(messages[0].password);
    await page.locator('[data-show="open-password"]').click();
    await page.locator("#open-password").press("Enter");
    await expect(page.locator("#recovered-text")).toHaveText(messages[0].text);
    await expect(page.locator("#paste")).toBeVisible();
  }
  for (const text of [transport + " ", archive.replace("001 ", "002 ")]) {
    await page.locator("#paste").click();
    await page.locator("#encoded").fill(text);
    await page
      .getByRole("button", { name: "Load backup", exact: true })
      .click();
    await expect(page.locator("#decrypt-error")).toBeVisible();
    await expect(page.locator("#decrypt-form")).toBeHidden();
    await expect(page.locator("#recovered-text")).toHaveText("");
  }
  // A new paste replaces the loaded backup without requiring a reset control.
  const replacement = await encryptEnvelope([messages[1]]);
  await loadText(page, encodeTransport(replacement));
  await recover(page, messages[1].password, messages[1].text);
});

// Public fixtures only: never use real private backups in browser artifacts.
test("four independent messages share one fixed backup and the saved reader stays clean", async ({
  page,
  browser,
}) => {
  const external: string[] = [];
  page.on("request", (request) => {
    if (
      !request.url().startsWith("http://127.0.0.1:4175/") &&
      !/^(data|blob):/.test(request.url())
    )
      external.push(request.url());
  });
  await page.goto("/");
  await expect(
    page.locator("#clear-open, #choose-file, #backup-file, #save-binary, #pdf"),
  ).toHaveCount(0);
  await expect(
    page.getByText("Save an encrypted copy", { exact: true }),
  ).toHaveCount(0);
  await enterMessages(page, MAX_MESSAGES);
  await expect(page.locator("#add-message")).toBeDisabled();
  await expect(page.locator("#message-limit")).toBeVisible();
  await generate(page);
  const textPromise = page.waitForEvent("download");
  await page.locator("#save-text").click();
  const textDownload = await textPromise;
  expect(textDownload.suggestedFilename()).toBe("paperwarden-backup.txt");
  const encryptedText = await readFile((await textDownload.path())!, "utf8");
  expect(decodeTransport(encryptedText).length).toBe(BACKUP_BYTES);
  const readerPromise = page.waitForEvent("download");
  await page.locator("#save-reader").click();
  const reader = await readFile((await (await readerPromise).path())!);
  expect(reader).toEqual(await readFile("dist/paperwarden.html"));
  for (const message of messages) {
    expect(reader.toString()).not.toContain(message.text);
    expect(reader.toString()).not.toContain(message.password);
  }
  await page.locator("#decrypt-tab").click();
  await loadText(page, encryptedText);
  await page.locator("#open-password").fill("wrong public test password");
  await page.locator("#open-button").click();
  await expect(page.locator("#decrypt-error")).toContainText("couldn't open");
  for (const message of messages) {
    await recover(page, message.password, message.text);
    await expect(page.locator("#recovered")).not.toContainText(
      /slot|additional|other messages/i,
    );
    await page.locator("#close-text").click();
    await expect(page.locator("#recovered-text")).toHaveText("");
  }
  expect(
    await page.evaluate(() => [localStorage.length, sessionStorage.length]),
  ).toEqual([0, 0]);
  expect(external).toEqual([]);

  // Reopen exactly the downloaded bytes in a fresh context. This deliberately
  // exercises HTTP delivery, not file:// compatibility or physical scanning.
  const isolated = await browser.newContext();
  const isolatedRequests: string[] = [];
  await isolated.route("**/*", async (route) => {
    if (route.request().url() === "http://127.0.0.1:4175/saved-reader") {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: reader,
      });
    } else {
      isolatedRequests.push(route.request().url());
      await route.abort();
    }
  });
  const saved = await isolated.newPage();
  try {
    await saved.goto("http://127.0.0.1:4175/saved-reader");
    await isolated.setOffline(true);
    await saved.locator("#decrypt-tab").click();
    await loadText(saved, encryptedText);
    await recover(saved, messages[3].password, messages[3].text);
    expect(isolatedRequests).toEqual([]);
  } finally {
    await isolated.close();
  }
});

test("shared capacity, text limits, duplicate passwords, and QR dimensions", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#size, #correction")).toHaveCount(0);
  const meter = page.locator("#capacity-meter");
  await expect(meter).toHaveAccessibleName("Backup space");
  await expect(page.locator("#capacity")).toHaveText("0% used");
  await expect(meter).toHaveJSProperty("value", 0);
  await expect(meter).toHaveJSProperty("max", MAX_TEXT_BYTES);
  await enterMessages(page);
  await expect(meter).toHaveJSProperty(
    "value",
    Buffer.byteLength(messages[0].text),
  );
  await generate(page);
  const shortSvg = decodeURIComponent(
    (await page.locator("#qr").getAttribute("src"))!
      .split(",")
      .slice(1)
      .join(","),
  );
  const viewBox = /viewBox="([^"]+)"/.exec(shortSvg)![1];
  expect(viewBox).toBe("0 0 185 185");
  await page.locator("#text").fill("x".repeat(MAX_TEXT_BYTES - 1));
  await expect(page.locator("#capacity")).toHaveText("99% used");
  await expect(meter).toHaveJSProperty("value", MAX_TEXT_BYTES - 1);
  await page.locator("#text").fill("x".repeat(MAX_TEXT_BYTES));
  await expect(page.locator("#stale")).toBeVisible();
  await expect(page.locator("#print")).toBeDisabled();
  await expect(page.locator("#print-root")).toBeEmpty();
  await expect(page.locator("#capacity")).toHaveText("Full");
  await expect(meter).toHaveJSProperty("value", MAX_TEXT_BYTES);
  await expect(meter).toHaveAttribute("aria-valuetext", "Full");
  await generate(page);
  const fullSvg = decodeURIComponent(
    (await page.locator("#qr").getAttribute("src"))!
      .split(",")
      .slice(1)
      .join(","),
  );
  expect(/viewBox="([^"]+)"/.exec(fullSvg)![1]).toBe(viewBox);
  await page
    .locator("#text")
    .fill("é".repeat(Math.ceil(MAX_TEXT_BYTES / 2) + 1));
  await expect(page.locator("#capacity")).toHaveText(
    "Over capacity — shorten your text",
  );
  await expect(meter).toHaveJSProperty("value", MAX_TEXT_BYTES);
  await expect(meter).toHaveAttribute(
    "aria-valuetext",
    "Over capacity — shorten your text",
  );
  await page.locator("#encrypt-button").click();
  await expect(page.locator("#encrypt-error")).toContainText("do not fit");
  await page.locator("#clear-create").click();
  await enterMessages(page, 2);
  await expect(meter).toHaveAccessibleName("Shared backup space");
  const used = messages
    .slice(0, 2)
    .reduce((total, message) => total + Buffer.byteLength(message.text), 0);
  await expect(page.locator("#capacity")).toHaveText(
    `${Math.floor((used / maximumTextBytes(2)) * 100)}% used`,
  );
  await expect(meter).toHaveJSProperty("value", used);
  await expect(meter).toHaveJSProperty("max", maximumTextBytes(2));
  await page
    .locator("[data-message]")
    .nth(1)
    .locator("[data-password]")
    .fill(messages[0].password);
  await page.locator("#encrypt-button").click();
  await expect(page.locator("#encrypt-error")).toContainText(
    "different password",
  );
  await page.locator(".remove-message").click();
  await expect(page.locator("[data-message]")).toHaveCount(1);
  await expect(meter).toHaveAccessibleName("Backup space");
  await expect(meter).toHaveJSProperty("max", MAX_TEXT_BYTES);
  await expect(meter).toHaveJSProperty(
    "value",
    Buffer.byteLength(messages[0].text),
  );
});

test("password toggles, tabs, keyboard, narrow layout, and About remain accessible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto("/");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const width = await elementWidth(page, "#password");
  await page.locator('[data-show="password"]').click();
  await expect(page.locator("#password")).toHaveAttribute("type", "text");
  expect(await elementWidth(page, "#password")).toBe(width);
  await page.locator('[data-show="password"]').click();
  expect(await elementWidth(page, "#password")).toBe(width);
  const before = await page
    .locator("#main")
    .evaluate((node) => node.getBoundingClientRect().left);
  await page.locator("#decrypt-tab").focus();
  await page.keyboard.press("Enter");
  expect(
    await page
      .locator("#main")
      .evaluate((node) => node.getBoundingClientRect().left),
  ).toBe(before);
  await expect(page.locator("#decrypt-heading")).toBeFocused();
  await page.locator("#about").click();
  await expect(page.locator("#close-about")).toBeFocused();
  const technical = page.locator("#technical-details");
  await expect(technical.locator("summary")).toHaveText("Technical details");
  await expect(technical).toHaveJSProperty("open", false);
  await expect(technical.locator("p").first()).toBeHidden();
  await expect(
    page
      .locator(".dialog-content > p")
      .filter({ hasText: "has not had an independent security audit" }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await technical.locator("summary").click();
  await expect(technical).toHaveJSProperty("open", true);
  await expect(technical.locator("p").first()).toBeVisible();
  const headingTop = await page
    .locator(".dialog-heading")
    .evaluate((node) => node.getBoundingClientRect().top);
  await page.locator(".dialog-content").press("End");
  expect(
    await page
      .locator(".dialog-heading")
      .evaluate((node) => node.getBoundingClientRect().top),
  ).toBe(headingTop);
  await page.keyboard.press("Escape");
  await expect(page.locator("#about-dialog")).not.toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  await page.locator("#encrypt-tab").click();
  await enterMessages(page, 4);
  await page.locator("#text").fill("x".repeat(MAX_TEXT_BYTES));
  await expect(page.locator("#capacity")).toHaveText(
    "Over capacity — shorten your text",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.locator("#decrypt-tab").click();
  const fixture = await encryptEnvelope([messages[0]]);
  await loadText(page, encodeTransport(fixture));
  await recover(page, messages[0].password, messages[0].text);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("clearing a pending job prevents a late result from repopulating the page", async ({
  page,
}) => {
  const fixture = Array.from(await encryptEnvelope([messages[0]]));
  await page.addInitScript((bytes) => {
    // Model an already queued worker reply arriving after termination. The real
    // client must ignore it, and the UI must never repopulate cleared results.
    class DelayedWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror = null;
      onmessageerror = null;
      postMessage() {
        const callback = this.onmessage;
        setTimeout(() => {
          callback?.({
            data: { ok: true, value: new Uint8Array(bytes) },
          } as MessageEvent);
          document.documentElement.dataset.testReplyDelivered = "true";
        }, 400);
      }
      terminate() {
        /* Intentionally leave the queued callback pending. */
      }
    }
    window.Worker = DelayedWorker as unknown as typeof Worker;
  }, fixture);
  await page.goto("/");
  await enterMessages(page);
  await page.locator("#encrypt-button").click();
  await expect(page.locator("#main")).toHaveAttribute("aria-busy", "true");
  await page.locator("#clear-create").click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-test-reply-delivered",
    "true",
  );
  await expect(page.locator("#main")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#text")).toHaveValue("");
  await expect(page.locator("#password")).toHaveValue("");
  await expect(page.locator("#backup-result")).not.toBeVisible();
  await expect(page.locator("#print-root")).toBeEmpty();
  await expect(page.locator("#encrypt-error")).not.toBeVisible();
});

test("a camera frame-capture failure stops its tracks and reports the failure", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 320;
    const context = canvas.getContext("2d")!;
    context.fillRect(0, 0, 320, 320);
    const stream = canvas.captureStream(20);
    // Deliver real frames without camera hardware or a permission prompt.
    const interval = setInterval(() => context.fillRect(0, 0, 320, 320), 40);
    const track = stream.getVideoTracks()[0];
    const stop = track.stop.bind(track);
    track.stop = () => {
      clearInterval(interval);
      stop();
      document.documentElement.dataset.testCameraStopped = track.readyState;
    };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => stream,
    });
    const drawImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (
      this: CanvasRenderingContext2D,
      source: CanvasImageSource,
      ...coordinates: number[]
    ) {
      if (source instanceof HTMLVideoElement) {
        document.documentElement.dataset.testCaptureFailure = "true";
        throw new DOMException(
          "Simulated frame capture failure",
          "InvalidStateError",
        );
      }
      Reflect.apply(drawImage, this, [source, ...coordinates]);
    };
  });
  await page.locator("#decrypt-tab").click();
  await page.locator("#scan").click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-test-capture-failure",
    "true",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-test-camera-stopped",
    "ended",
  );
  await expect(page.locator("#camera")).not.toBeVisible();
  await expect(page.locator("#decrypt-error")).toBeVisible();
  await expect(page.locator("#decrypt-error")).not.toHaveText("");
  expect(
    await page
      .locator("#video")
      .evaluate((node: HTMLVideoElement) => node.srcObject),
  ).toBeNull();
  expect(errors).toEqual([]);
});

test("a camera permission reply arriving after navigation releases its new tracks", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 320;
    const stream = canvas.captureStream(10);
    const track = stream.getVideoTracks()[0];
    const stop = track.stop.bind(track);
    track.stop = () => {
      stop();
      document.documentElement.dataset.testLateCameraStopped = track.readyState;
    };
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: () =>
        new Promise<MediaStream>((resolve) => {
          document.documentElement.dataset.testCameraPending = "true";
          document.addEventListener(
            "test-release-camera",
            () => resolve(stream),
            { once: true },
          );
        }),
    });
  });
  await page.locator("#decrypt-tab").click();
  await page.locator("#scan").click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-test-camera-pending",
    "true",
  );
  await page.locator("#encrypt-tab").click();
  await page.evaluate(() =>
    document.dispatchEvent(new Event("test-release-camera")),
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-test-late-camera-stopped",
    "ended",
  );
  await expect(page.locator("#encrypt-view")).toBeVisible();
  await expect(page.locator("#camera")).not.toBeVisible();
  await expect(page.locator("#decrypt-error")).not.toBeVisible();
  expect(
    await page
      .locator("#video")
      .evaluate((node: HTMLVideoElement) => node.srcObject),
  ).toBeNull();
});
