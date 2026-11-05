import { choosePhoto, openPhotoChooser } from "./choose-photo";
import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { formatShortBackupId } from "../../src/encoding/backup-id";
import { encodeTransport } from "../../src/encoding/transport";
import { encodeLink, LINK_PAYLOAD_CHARACTERS } from "../../src/encoding/link";
import QRCode from "qrcode";
import { BACKUP_BYTES, PREAMBLE } from "../../src/format/constants";
import { encryptEnvelope } from "../../src/format/envelope";

function structuralBackup() {
  const bytes = Uint8Array.from({ length: BACKUP_BYTES }, (_, i) => i & 255);
  bytes.set(PREAMBLE);
  return bytes;
}

function loadedLabel(bytes: Uint8Array) {
  const words = formatShortBackupId(
    createHash("sha256").update(bytes).digest("hex"),
  );
  return `Backup ${words} loaded.`;
}

async function observeImports(page: Page, holdFirst = false) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate((hold) => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let count = 0;
    document.documentElement.dataset.importHashes = "0";
    crypto.subtle.digest = async (algorithm, data) => {
      if (data.byteLength !== 2858) return digest(algorithm, data);
      const call = ++count;
      document.documentElement.dataset.importHashes = String(count);
      const result = await digest(algorithm, data);
      if (hold && call === 1) {
        document.documentElement.dataset.importHeld = "true";
        await new Promise<void>((resolve) => {
          document.addEventListener("test-release-import", () => resolve(), {
            once: true,
          });
        });
        document.documentElement.dataset.importReleased = "true";
      }
      return result;
    };
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => {
          // No hardware access or permission prompt; cancellation owns no tracks.
          return new Promise<MediaStream>(() => {});
        },
      },
    });
  }, holdFirst);
  return errors;
}

const cancellations = [
  "clear text",
  "switch tab",
  "scan",
  "cancel image picker",
  "reset recovery link",
  "pagehide",
] as const;

async function cancelImport(
  page: Page,
  action: (typeof cancellations)[number],
) {
  if (action === "clear text") await page.locator("#encoded").fill("");
  else if (action === "switch tab") await page.locator("#encrypt-tab").click();
  else if (action === "scan") {
    await page.locator("#scan").click();
    await expect
      .poll(
        async () =>
          (await page.locator("#camera").isVisible()) ||
          (await page.locator("#decrypt-error").isVisible()),
      )
      .toBe(true);
  } else if (action === "cancel image picker") {
    await choosePhoto(page, []);
  } else if (action === "pagehide") {
    await page.evaluate(() =>
      window.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted: true }),
      ),
    );
  } else {
    await page.evaluate(() => {
      history.replaceState(null, "", "#discard");
      location.hash = "";
    });
    await expect(page.locator("#encoded")).toHaveValue("");
  }
}

test("incomplete typed input stays editable and a keyboard correction imports it automatically", async ({
  page,
}) => {
  const bytes = structuralBackup();
  const text = encodeTransport(bytes);
  await page.goto("/");
  await page.locator("#decrypt-tab").click();
  await page.locator("#encoded").fill(text.slice(0, -1));
  await expect(page.locator("#decrypt-error")).toBeVisible();
  await expect(page.locator("#encoded")).toBeEditable();
  await expect(page.locator("#encoded")).toHaveValue(text.slice(0, -1));
  await expect(page.locator("#decrypt-form")).toBeHidden();
  await page.locator("#encoded").press("ControlOrMeta+End");
  await page.locator("#encoded").pressSequentially(text.slice(-1));
  await expect(page.locator("#loaded-backup-id")).toHaveText(
    loadedLabel(bytes),
  );
  await expect(page.locator("#open-password")).toBeFocused();
  await expect(page.locator("#decrypt-error")).toBeHidden();
  await expect(page.locator("#encoded")).toHaveValue("");
});

test("a real clipboard paste imports a backup link without submitting or navigating", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Playwright clipboard permissions are Chromium-specific",
  );
  const bytes = structuralBackup();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.locator("#decrypt-tab").click();
  const url = page.url();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.evaluate(
    (text) => navigator.clipboard.writeText(text),
    encodeLink(bytes, "https://gone.invalid/"),
  );
  await page.locator("#encoded").focus();
  await page.locator("#encoded").press("ControlOrMeta+V");
  await expect(page.locator("#loaded-backup-id")).toHaveText(
    loadedLabel(bytes),
  );
  await expect(page.locator("#open-password")).toBeFocused();
  await expect(page).toHaveURL(url);
  expect(requests).toEqual([]);
});

for (const action of cancellations) {
  test(`queued text import is cancelled by ${action}`, async ({ page }) => {
    await page.goto("/");
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
    const errors = await observeImports(page);
    await page.locator("#decrypt-tab").click();
    await page.locator("#encoded").fill(encodeTransport(structuralBackup()));
    await cancelImport(page, action);
    // Advance beyond the debounce deadline rather than relying on a race or sleep.
    await page.clock.runFor(500);
    await expect(page.locator("html")).toHaveAttribute(
      "data-import-hashes",
      "0",
    );
    await expect(page.locator("#loaded-backup-id")).toBeEmpty();
    await expect(page.locator("#decrypt-form")).toBeHidden();
    await expect(page.locator("#main")).toHaveAttribute("aria-busy", "false");
    expect(errors).toEqual([]);
  });

  test(`an in-flight text import cannot publish after ${action}`, async ({
    page,
  }) => {
    await page.goto("/");
    const errors = await observeImports(page, true);
    await page.locator("#decrypt-tab").click();
    await page.locator("#encoded").fill(encodeTransport(structuralBackup()));
    await expect(page.locator("html")).toHaveAttribute(
      "data-import-held",
      "true",
    );
    await expect(page.locator("#encoded")).toBeEditable();
    await cancelImport(page, action);
    await page.evaluate(() =>
      document.dispatchEvent(new Event("test-release-import")),
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-import-released",
      "true",
    );
    await expect(page.locator("#loaded-backup-id")).toBeEmpty();
    await expect(page.locator("#decrypt-form")).toBeHidden();
    await expect(page.locator("#open-password")).toHaveValue("");
    await expect(page.locator("#main")).toHaveAttribute("aria-busy", "false");
    expect(errors).toEqual([]);
  });
}

test("a replacement text import keeps its own ID and encrypted bytes after an older hash finishes", async ({
  page,
}) => {
  const message = {
    text: "Public replacement import fixture",
    password: "public replacement river copper",
  };
  const replacement = await encryptEnvelope([message]);
  await page.goto("/");
  await observeImports(page, true);
  await page.locator("#decrypt-tab").click();
  await page.locator("#encoded").fill(encodeTransport(structuralBackup()));
  await expect(page.locator("html")).toHaveAttribute(
    "data-import-held",
    "true",
  );
  await page.locator("#encoded").fill(encodeTransport(replacement));
  await expect(page.locator("#loaded-backup-id")).toHaveText(
    loadedLabel(replacement),
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("test-release-import")),
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-import-released",
    "true",
  );
  await expect(page.locator("#loaded-backup-id")).toHaveText(
    loadedLabel(replacement),
  );
  await page.locator("#open-password").fill(message.password);
  await page.locator("#open-button").click();
  await expect(page.locator("#recovered-text")).toHaveText(message.text);
});

for (const action of ["switch tab", "pagehide"] as const) {
  test(`an image picker completed after ${action} cannot start a new import`, async ({
    page,
  }) => {
    const bytes = structuralBackup();
    const link = encodeLink(bytes);
    const split = link.length - LINK_PAYLOAD_CHARACTERS;
    const svg = await QRCode.toString(
      [
        { data: Buffer.from(link.slice(0, split)), mode: "byte" },
        { data: link.slice(split), mode: "alphanumeric" },
      ],
      { type: "svg", version: 40, errorCorrectionLevel: "L", margin: 4 },
    );
    const image = {
      name: "public-recovery.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from(svg),
    };
    await page.goto("/");
    await page.locator("#decrypt-tab").click();
    const chooser = await openPhotoChooser(page);
    await cancelImport(page, action);
    await chooser.setFiles(image);
    await expect(page.locator("#main")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#loaded-backup-id")).toBeEmpty();
    await expect(page.locator("#decrypt-form")).toBeHidden();
    await page.locator("#decrypt-tab").click();
    await expect(page.locator("#input-methods")).toBeVisible();
    // Rejecting the stale picker must not prevent a later intentional choice.
    await choosePhoto(page, image);
    await expect(page.locator("#loaded-backup-id")).toHaveText(
      loadedLabel(bytes),
    );
  });
}
