import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  QRCodeReader,
  RGBLuminanceSource,
} from "@zxing/library";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { encryptEnvelope } from "../../src/format/envelope";
import {
  BACKUP_BYTES,
  MAX_TEXT_BYTES,
  PREAMBLE,
} from "../../src/format/constants";
import { decodeTransport, encodeTransport } from "../../src/encoding/transport";
import { encodeArchive } from "../../src/encoding/archive";
import { encodeLink, READER_URL } from "../../src/encoding/link";
import { formatBackupId } from "../../src/encoding/backup-id";

const origin = "http://127.0.0.1:4175";
const messages = [
  {
    text: "PUBLIC LINK FIXTURE — first message 🌿\nKeep these spaces  ",
    password: "public linked river copper garden",
  },
  {
    text: "PUBLIC LINK FIXTURE — second message\n保持 Café",
    password: "public linked moon linen forest",
  },
];

function backupIdLabel(bytes: Uint8Array) {
  return `Backup ID: ${formatBackupId(createHash("sha256").update(bytes).digest("hex"))}`;
}

async function expectLoadedId(page: Page, bytes: Uint8Array) {
  await expect(page.locator("#loaded-backup-id")).toBeVisible();
  await expect(page.locator("#loaded-backup-id")).toHaveText(
    backupIdLabel(bytes),
  );
  await expect(page.locator("#open-password")).toHaveValue("");
  await expect(page.locator("#recovered")).toBeHidden();
}

function structuralBackup() {
  // Public structural data is sufficient for pre-password identification tests.
  const bytes = Uint8Array.from(
    { length: BACKUP_BYTES },
    (_, index) => index & 255,
  );
  bytes.set(PREAMBLE);
  return bytes;
}

async function generate(page: Page) {
  await page.locator("#encrypt-button").click();
  await expect(page.locator("#backup-result")).toBeVisible();
  await expect(page.locator("#print")).toBeEnabled();
}

async function downloadFile(page: Page, button: string) {
  const downloadEvent = page.waitForEvent("download");
  await page.locator(button).click();
  const downloaded = await downloadEvent;
  return readFile((await downloaded.path())!);
}

async function recover(page: Page, message: (typeof messages)[number]) {
  await expect(page.locator("#decrypt-form")).toBeVisible();
  await page.locator("#open-password").fill(message.password);
  await page.locator("#open-button").click();
  await expect(page.locator("#recovered")).toBeVisible();
  expect(await page.locator("#recovered-text").textContent()).toBe(
    message.text,
  );
  await expect(page.locator("#open-password")).toHaveValue("");
}

async function captureQr(page: Page) {
  // Rasterize the actual generated UI image, without reconstructing its QR.
  const raster = await page.locator("#qr").evaluate(async (node) => {
    const image = node as HTMLImageElement;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 740;
    const context = canvas.getContext("2d")!;
    context.imageSmoothingEnabled = false;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const luminance = Array.from(
      { length: canvas.width * canvas.height },
      (_, index) => pixels[index * 4],
    );
    return { png: canvas.toDataURL("image/png").split(",")[1], luminance };
  });
  const bitmap = new BinaryBitmap(
    new HybridBinarizer(
      new RGBLuminanceSource(new Uint8ClampedArray(raster.luminance), 740, 740),
    ),
  );
  const text = new QRCodeReader()
    .decode(bitmap, new Map([[DecodeHintType.PURE_BARCODE, true]]))
    .getText();
  return { png: Buffer.from(raster.png, "base64"), text };
}

test("full-capacity QR backups link to the reader by default and show a matching six-word ID", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#include-link, #short-fingerprint")).toHaveCount(
    0,
  );
  await page.locator("#text").fill("x".repeat(MAX_TEXT_BYTES));
  await page.locator("#password").fill(messages[0].password);
  await expect(page.locator("#capacity")).toHaveText("Full");
  await generate(page);
  const raw = (await downloadFile(page, "#save-text")).toString("utf8");
  expect(raw).toMatch(/^PWN:/);
  const bytes = decodeTransport(raw);
  expect(bytes).toHaveLength(BACKUP_BYTES);
  const captured = await captureQr(page);
  expect(captured.text).toBe(encodeLink(bytes));
  expect(captured.text).toMatch(/^https:\/\/paperwarden\.com\/#PWN1:/);
  const backupId = formatBackupId(
    createHash("sha256").update(bytes).digest("hex"),
  );
  expect(backupId).toMatch(/^[a-z]+(?: [a-z]+){5}$/);
  await expect(page.locator("#backup-id")).toHaveText(backupIdLabel(bytes));
  await expect(page.locator("#backup-id")).toHaveCSS("font-style", "italic");
  await expect(page.locator("#print-root")).toContainText(backupIdLabel(bytes));
  await page.setViewportSize({ width: 320, height: 800 });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("link landing and hash changes clear the address bar and keep saved readers pristine", async ({
  browser,
}) => {
  const bytes = await encryptEnvelope(messages);
  const fragment = new URL(encodeLink(bytes)).hash;
  const reader = await readFile("dist/paperwarden.html");
  const localUrl = `${origin}/linked-reader`;
  const requests: string[] = [];
  const unexpected: string[] = [];
  const context = await browser.newContext();
  context.on("request", (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === localUrl || url === `${localUrl}/after`) {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: reader,
      });
    } else {
      unexpected.push(url);
      await route.abort();
    }
  });
  const page = await context.newPage();
  try {
    await page.goto(localUrl + fragment);
    await expect(page).toHaveURL(localUrl);
    await expect(page.locator("#decrypt-view")).toBeVisible();
    await expect(page.locator("#open-password")).toBeFocused();
    await expect(page.locator("#open-password")).toHaveValue("");
    await expect(page.locator("#recovered")).toBeHidden();
    await expectLoadedId(page, bytes);
    expect(requests).toEqual([localUrl]);
    const savedReader = await downloadFile(page, "#save-reader");
    expect(savedReader).toEqual(reader);
    expect(savedReader.toString()).not.toContain(fragment);
    for (const message of messages) {
      expect(savedReader.toString()).not.toContain(message.text);
      expect(savedReader.toString()).not.toContain(message.password);
    }
    await recover(page, messages[0]);
    await page.evaluate(() => {
      location.hash = "#PWN1:invalid-public-fixture";
    });
    await expect(page).toHaveURL(localUrl);
    await expect(page.locator("#decrypt-error")).toBeVisible();
    await expect(page.locator("#decrypt-form")).toBeHidden();
    await expect(page.locator("#recovered-text")).toHaveText("");
    await expect(page.locator("#open-password")).toHaveValue("");
    await expect(page.locator("#loaded-backup-id")).toBeEmpty();
    await expect(page.locator("#loaded-backup-id")).toBeHidden();
    await page.evaluate((hash) => {
      location.hash = hash;
    }, fragment);
    await expect(page).toHaveURL(localUrl);
    await expect(page.locator("#open-password")).toBeFocused();
    await expect(page.locator("#decrypt-error")).toBeHidden();
    await expectLoadedId(page, bytes);
    await recover(page, messages[1]);
    expect(requests).toEqual([localUrl]);
    await page.goto(`${localUrl}/after`);
    await page.goBack();
    await expect(page).toHaveURL(localUrl);
    await expect(page.locator("#recovered-text")).toHaveText("");
    await expect(page.locator("#open-password")).toHaveValue("");
    await expect(page.locator("#loaded-backup-id")).toBeEmpty();
    expect(requests.every((url) => !url.includes("#"))).toBe(true);
    expect(unexpected).toEqual([]);
  } finally {
    await context.close();
  }
});

test("an offline saved reader opens linked QR photos and links to an unavailable domain locally", async ({
  page,
  browser,
}) => {
  await page.goto("/");
  await page.locator("#text").fill(messages[0].text);
  await page.locator("#password").fill(messages[0].password);
  await page.locator("#add-message").click();
  await page.locator(".additional-message [data-text]").fill(messages[1].text);
  await page
    .locator(".additional-message [data-password]")
    .fill(messages[1].password);
  await generate(page);
  const captured = await captureQr(page);
  const bytes = decodeTransport(
    (await downloadFile(page, "#save-text")).toString("utf8"),
  );
  expect(captured.text).toBe(encodeLink(bytes, READER_URL));
  const reader = await downloadFile(page, "#save-reader");
  expect(reader).toEqual(await readFile("dist/paperwarden.html"));
  const unavailableLink = encodeLink(
    bytes,
    "https://gone-paperwarden.invalid/",
  );
  const localUrl = `${origin}/offline-linked-reader`;
  const requests: string[] = [];
  const context = await browser.newContext();
  context.on("request", (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  await context.route("**/*", async (route) => {
    if (route.request().url() === localUrl) {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: reader,
      });
    } else await route.abort();
  });
  const offline = await context.newPage();
  try {
    await offline.goto(localUrl);
    await context.setOffline(true);
    await offline.locator("#decrypt-tab").click();
    await offline.locator("#photo").setInputFiles({
      name: "public-linked-qr.png",
      mimeType: "image/png",
      buffer: captured.png,
    });
    await expect(offline.locator("#open-password")).toBeFocused();
    await expectLoadedId(offline, bytes);
    for (const message of messages) {
      await recover(offline, message);
      await offline.locator("#close-text").click();
    }
    await offline.locator("#paste").click();
    await offline.locator("#encoded").fill(unavailableLink);
    await offline.locator("#paste-form button").click();
    await expect(offline.locator("#open-password")).toBeFocused();
    await expectLoadedId(offline, bytes);
    for (const message of messages) {
      await recover(offline, message);
      await offline.locator("#close-text").click();
    }
    await expect(offline).toHaveURL(localUrl);
    expect(requests).toEqual([localUrl]);
    expect(
      await offline.evaluate(() => [
        localStorage.length,
        sessionStorage.length,
      ]),
    ).toEqual([0, 0]);
  } finally {
    await context.close();
  }
});

test("the loaded ID matches raw text, archival text and links before a password, and replacement cannot retain an old ID", async ({
  page,
}) => {
  const bytes = structuralBackup();
  const replacement = bytes.slice();
  replacement[BACKUP_BYTES - 1] ^= 1;
  expect(backupIdLabel(replacement)).not.toBe(backupIdLabel(bytes));
  await page.goto("/");
  await page.locator("#decrypt-tab").click();
  for (const [text, expected] of [
    [encodeTransport(bytes), bytes],
    [await encodeArchive(bytes), bytes],
    [encodeLink(bytes), bytes],
    [encodeTransport(replacement), replacement],
  ] as const) {
    await page.locator("#paste").click();
    await page.locator("#encoded").fill(text);
    await page.locator("#paste-form button").click();
    await expectLoadedId(page, expected);
    await expect(page.locator("#decrypt-form")).toBeVisible();
  }
  await page.locator("#paste").click();
  await page.locator("#encoded").fill("PWN:incomplete-public-fixture");
  await page.locator("#paste-form button").click();
  await expect(page.locator("#decrypt-error")).toBeVisible();
  await expect(page.locator("#decrypt-form")).toBeHidden();
  await expect(page.locator("#loaded-backup-id")).toBeEmpty();
  await expect(page.locator("#loaded-backup-id")).toBeHidden();
});

for (const action of ["switch view", "clear fragment"] as const) {
  test(`a pending linked backup cannot repopulate its ID after ${action}`, async ({
    page,
  }) => {
    await page.goto("/");
    await page.evaluate(() => {
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      const state = window as unknown as { releaseBackupId?: () => void };
      crypto.subtle.digest = async (algorithm, data) => {
        const result = await digest(algorithm, data);
        if (data.byteLength === 2858) {
          document.documentElement.dataset.idPending = "true";
          await new Promise<void>((resolve) => {
            state.releaseBackupId = resolve;
          });
          document.documentElement.dataset.idReleased = "true";
        }
        return result;
      };
    });
    await page.evaluate(
      (fragment) => {
        location.hash = fragment;
      },
      new URL(encodeLink(structuralBackup())).hash,
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-id-pending",
      "true",
    );
    await expect(page.locator("#loaded-backup-id")).toBeEmpty();
    await expect(page.locator("#decrypt-form")).toBeHidden();
    if (action === "switch view") {
      await page.locator("#encrypt-tab").click();
      await expect(page.locator("#encrypt-view")).toBeVisible();
    } else {
      // The app already consumed its hash. A fragment-only address change then
      // clearing it exercises the browser's real empty-hash event, not a fake call.
      await page.evaluate(() => {
        history.replaceState(null, "", "#discard");
        location.hash = "";
      });
      await expect(page.locator("#main")).toHaveAttribute("aria-busy", "false");
    }
    await page.evaluate(() => {
      (window as unknown as { releaseBackupId: () => void }).releaseBackupId();
    });
    await expect(page.locator("html")).toHaveAttribute(
      "data-id-released",
      "true",
    );
    await expect(page.locator("#loaded-backup-id")).toBeEmpty();
    await expect(page.locator("#loaded-backup-id")).toBeHidden();
    await expect(page.locator("#decrypt-form")).toBeHidden();
    await expect(page.locator("#open-password")).toHaveValue("");
    if (action === "switch view")
      await expect(page.locator("#encrypt-view")).toBeVisible();
  });
}
