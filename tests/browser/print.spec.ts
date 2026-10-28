import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { decodeArchive } from "../../src/encoding/archive";
import { decodeTransport } from "../../src/encoding/transport";
import { formatBackupId } from "../../src/encoding/backup-id";

const PDFTOPPM = process.env.PDFTOPPM_PATH ?? "pdftoppm";
const PDFTOTEXT = process.env.PDFTOTEXT_PATH ?? "pdftotext";
const mainText =
  "PUBLIC PRINT FIXTURE — private text must never appear on paper.\nKeep spaces  🌿";
const extraText =
  "PUBLIC ADDITIONAL FIXTURE — this message must remain unprinted.\n保持";
const mainPassword = "public fixture river morning copper";
const extraPassword = "public fixture moon forest linen";

function available(command: string): boolean {
  try {
    execFileSync(command, ["-v"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function create(page: Page) {
  await page.goto("/");
  await page.locator("#text").fill(mainText);
  await page.locator("#password").fill(mainPassword);
  await page.locator("#add-message").click();
  await page.locator(".additional-message [data-text]").fill(extraText);
  await page.locator(".additional-message [data-password]").fill(extraPassword);
  await page.locator("#encrypt-button").click();
  await expect(page.locator("#backup-result")).toBeVisible({ timeout: 60000 });
  await expect(page.locator("#print")).toBeEnabled();
}

async function recover(page: Page, password: string, expected: string) {
  await expect(page.locator("#decrypt-form")).toBeVisible();
  await page.locator("#open-password").fill(password);
  await page.locator("#open-button").click();
  await expect(page.locator("#recovered")).toBeVisible({ timeout: 60000 });
  expect(await page.locator("#recovered-text").textContent()).toBe(expected);
}

function printedArchive(text: string): string {
  const fingerprint = /SHA256[ \t]+([a-f0-9]{64})/.exec(text);
  expect(
    fingerprint,
    "Full fingerprint must remain intact in the PDF",
  ).not.toBeNull();
  const lines = text
    .replaceAll("\f", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d{3}\s/.test(line));
  expect(
    lines,
    "All 115 archive lines must be printed without splitting or repetition",
  ).toHaveLength(115);
  return `PWN-1 ARCHIVE\nSHA256 ${fingerprint![1]}\n${lines.join("\n")}`;
}

test("printing uses the prepared encrypted-only snapshot, and editing invalidates exports", async ({
  page,
}) => {
  await create(page);
  const printText = await page.locator("#print-root").textContent();
  for (const secret of [
    "PUBLIC PRINT FIXTURE",
    "PUBLIC ADDITIONAL FIXTURE",
    mainPassword,
    extraPassword,
  ])
    expect(printText).not.toContain(secret);
  expect(printText).not.toMatch(
    /(?:message count|two messages|2 messages|additional message)/i,
  );
  await expect(page.locator("#print-root .archive-line")).toHaveCount(116);
  await expect(page.locator("#print-root img")).toHaveAttribute(
    "src",
    /^data:image\/svg\+xml/,
  );
  await page.evaluate(() => {
    let count = 0;
    window.print = () => {
      document.documentElement.dataset.printCalls = String(++count);
    };
  });
  await page.locator("#print").click();
  await expect(page.locator("html")).toHaveAttribute("data-print-calls", "1");
  await expect(page.locator("#save-text")).toBeVisible();
  await expect(page.locator("#save-text")).toBeEnabled();
  await page.locator("#text").fill("Changed public fixture");
  await expect(page.locator("#stale")).toBeVisible();
  await expect(page.locator("#print")).toBeDisabled();
  await expect(page.locator("#save-text")).toBeDisabled();
  await expect(page.locator("#print-root")).toBeEmpty();
  await page.locator("#clear-create").click();
  await expect(page.locator("#backup-result")).toBeHidden();
  await expect(page.locator("#print-root")).toBeEmpty();
});

for (const format of ["A4", "Letter"] as const) {
  test(`${format} linked PDF recovers its whole-page QR and complete archival transcription`, async ({
    page,
    browserName,
  }, testInfo) => {
    test.skip(
      browserName !== "chromium",
      "Playwright PDF export requires Chromium",
    );
    test.skip(
      !available(PDFTOPPM) || !available(PDFTOTEXT),
      "Install Poppler or set PDFTOPPM_PATH and PDFTOTEXT_PATH for PDF recovery checks",
    );
    test.setTimeout(120000);
    await create(page);
    const downloadEvent = page.waitForEvent("download");
    await page.locator("#save-text").click();
    const download = await downloadEvent;
    const encryptedPath = await download.path();
    expect(encryptedPath).not.toBeNull();
    const encrypted = Buffer.from(
      decodeTransport(await readFile(encryptedPath!, "utf8")),
    );
    expect(encrypted).toHaveLength(2858);
    const backupId = formatBackupId(
      createHash("sha256").update(encrypted).digest("hex"),
    );
    expect(backupId).toMatch(/^[a-z]+(?: [a-z]+){5}$/);
    await expect(page.locator("#backup-id")).toHaveText(
      `Backup ID: ${backupId}`,
    );

    const pdf = testInfo.outputPath(`backup-${format.toLowerCase()}.pdf`);
    await page.pdf({
      path: pdf,
      format,
      printBackground: true,
      displayHeaderFooter: false,
    });
    const extracted = execFileSync(PDFTOTEXT, ["-layout", pdf, "-"], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1_000_000,
    });
    expect(extracted).toContain("PAPERWARDEN");
    const prose = extracted.replace(/\s+/g, " ");
    expect(prose).toContain(`Backup ID: ${backupId}`);
    expect(prose).toContain("Paste backup");
    expect(prose).not.toContain("Use the archival written copy");
    expect(extracted).not.toContain("#PWN1:");
    expect(extracted).toContain("paperwarden.com");
    expect(prose).toContain("offline recovery");
    for (const secret of [
      "PUBLIC PRINT FIXTURE",
      "PUBLIC ADDITIONAL FIXTURE",
      mainPassword,
      extraPassword,
    ])
      expect(extracted).not.toContain(secret);
    expect(extracted).not.toMatch(
      /(?:message count|two messages|2 messages|additional message)/i,
    );
    const archive = printedArchive(extracted);
    expect(Buffer.from(await decodeArchive(archive))).toEqual(encrypted);

    await page.locator("#decrypt-tab").click();
    // Both pixel-grid alignments must recover the original complete PDF page;
    // there is no QR cropping, regeneration, or success-on-one-resolution retry.
    for (const resolution of [2200, 1800]) {
      const image = testInfo.outputPath(
        `backup-${format.toLowerCase()}-${resolution}`,
      );
      execFileSync(
        PDFTOPPM,
        [
          "-f",
          "1",
          "-singlefile",
          "-scale-to",
          String(resolution),
          "-png",
          pdf,
          image,
        ],
        { timeout: 30000, maxBuffer: 1_000_000 },
      );
      await page.locator("#photo").setInputFiles(image + ".png");
      await expect(page.locator("#choose-photo")).toBeEnabled({
        timeout: 30000,
      });
      await expect(page.locator("#decrypt-error")).toBeEmpty();
      await expect(page.locator("#load-message")).toContainText(
        "Backup loaded",
      );
      await expect(
        page.locator("#decrypt-form"),
        `The complete ${format} page must decode at ${resolution} pixels`,
      ).toBeVisible();
      await expect(page.locator("#loaded-backup-id")).toBeVisible();
      await expect(page.locator("#loaded-backup-id")).toHaveText(
        `Backup ID: ${backupId}`,
      );
      await expect(page.locator("#open-password")).toHaveValue("");
    }
    await recover(page, mainPassword, mainText);
    await page.locator("#paste").click();
    await page.locator("#encoded").fill(archive);
    await page.locator("#paste-form button").click();
    await expect(page.locator("#loaded-backup-id")).toBeVisible();
    await expect(page.locator("#loaded-backup-id")).toHaveText(
      `Backup ID: ${backupId}`,
    );
    await expect(page.locator("#open-password")).toHaveValue("");
    await recover(page, extraPassword, extraText);
  });
}
