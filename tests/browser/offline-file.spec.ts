import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { encodeLink } from "../../src/encoding/link";
import { PAYLOAD_BYTES } from "../../src/format/constants";
import reference from "../fixtures/reference.json" with { type: "json" };

test("the actual downloaded file recovers wrapped messages and generates passwords without a website", async ({
  page,
  browser,
}, testInfo) => {
  // Disposable public inputs exercise serialization after secret entry and QR creation.
  await page.goto("/");
  await expect(page.locator("#reader-status")).toHaveAttribute(
    "data-context",
    "hosted",
  );
  await expect(page.locator("#hosted-copy")).toBeVisible();
  await expect(page.locator("#save-reader")).toBeVisible();
  await expect(page.locator(".encryption-intro")).toHaveText(
    "Enter a message, choose a strong password, and print an encrypted QR code. Keep the password somewhere separate from the paper. For anything important, use the offline app.",
  );
  const singleMessageIntro =
    "Enter a message, choose a strong password, and print an encrypted QR code. Keep the password somewhere separate from the paper.";
  const twoMessageIntro =
    "Enter two messages, choose a different strong password for each, and print them together as one encrypted QR code. Keep the passwords somewhere separate from the paper.";
  await page.locator("#add-message").click();
  await expect(page.locator(".encryption-intro")).toHaveText(
    `${twoMessageIntro} For anything important, use the offline app.`,
  );
  await page.locator(".remove-message").click();
  await expect(page.locator("#encryption-summary")).toHaveText(
    singleMessageIntro,
  );
  const creationPasswords: string[] = [];
  for (let index = 0; index < 2; index++) {
    if (index) await page.locator("#add-message").click();
    const group = page.locator("[data-message]").nth(index);
    await group
      .locator("[data-text]")
      .fill(`Public offline-file test message ${index}`);
    await group.locator("[data-generate-password]").click();
    creationPasswords.push(await group.locator("[data-password]").inputValue());
  }
  await page.locator("#encrypt-button").click();
  await expect(page.locator("#backup-result")).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page.locator("#save-reader").click();
  const download = await downloading;
  const filename = `Family <img onerror=alert(1)> 100% ${"x".repeat(96)} café.html`;
  const savedPath = testInfo.outputPath(filename);
  await download.saveAs(savedPath);
  const savedBytes = await readFile(savedPath);
  expect(savedBytes).toEqual(await readFile("dist/paperwarden.html"));
  for (const password of creationPasswords)
    expect(savedBytes.toString()).not.toContain(password);
  expect(savedBytes.toString()).not.toContain(
    "Public offline-file test message",
  );
  await page.locator("#about").click();
  await expect(page.locator("a#about-save-reader")).toHaveAttribute(
    "download",
    "paperwarden.html",
  );
  await expect(page.locator("#about-save-reader")).toHaveAttribute(
    "href",
    /^blob:/,
  );
  const downloadingFromAbout = page.waitForEvent("download");
  await page.locator("#about-save-reader").click();
  const aboutDownload = await downloadingFromAbout;
  expect(aboutDownload.suggestedFilename()).toBe("paperwarden.html");
  expect(await readFile((await aboutDownload.path())!)).toEqual(savedBytes);
  await expect(page.locator("#about-dialog")).toBeVisible();
  await page.locator("#close-about").click();
  await expect(page.locator("#backup-result")).toBeVisible();
  // Both online views download the same pristine release after interaction.
  await page.locator("#decrypt-tab").click();
  await expect(page.locator(".recovery-intro")).toHaveText(
    "Scan the QR code, choose a photo of it, or paste the printed text or link. Then enter the password for the message you want to open. For anything important, use the offline app.",
  );
  await expect(page.locator("#hosted-copy")).toBeVisible();
  await expect(page.locator("#save-reader")).toBeVisible();
  const downloadingFromDecrypt = page.waitForEvent("download");
  await page.locator("#save-reader").click();
  const decryptDownload = await downloadingFromDecrypt;
  expect(await readFile((await decryptDownload.path())!)).toEqual(savedBytes);

  // Use a real file URL in a fresh context that is offline before the first load.
  // No route fulfillment or HTTP-hosted substitute is involved.
  const context = await browser.newContext({
    offline: true,
    viewport: { width: 390, height: 900 },
  });
  const fileUrl = pathToFileURL(savedPath).href;
  const unexpectedRequests: string[] = [];
  context.on("request", (request) => {
    const url = request.url();
    if (url !== fileUrl && !/^(blob|data):/.test(url))
      unexpectedRequests.push(url);
  });
  const local = await context.newPage();
  const pageErrors: string[] = [];
  local.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await local.goto(fileUrl);
    await expect(local.locator("#decrypt-view")).toBeVisible();
    await expect(local.locator("#encryption-context")).toHaveText(
      "Everything happens on this device.",
    );
    await expect(local.locator("#recovery-context")).toHaveText(
      "Everything happens on this device.",
    );
    await expect(local.locator("#reader-status")).toHaveAttribute(
      "data-context",
      "local",
    );
    await expect(local.locator("#local-copy")).toBeVisible();
    await expect(local.locator("#reader-status")).toHaveCSS(
      "text-align",
      "center",
    );
    await expect(local.locator("#reader-status")).toHaveText(
      "You're using a locally saved copy of Paperwarden. Verify it before entering sensitive information.",
      { useInnerText: true },
    );
    await expect(local.locator("#local-filename")).toHaveCount(0);
    await expect(local.locator("#reader-status")).not.toContainText(savedPath);

    expect(
      await local.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(local.locator("#hosted-copy")).toBeHidden();
    await expect(local.locator("#save-reader")).toBeHidden();
    await expect(local.locator("#password")).toHaveValue("");
    await expect(local.locator("[data-message]")).toHaveCount(1);
    await expect(local.locator("#backup-result")).toBeHidden();
    await local.locator("#about").click();
    await expect(local.locator("#about-dialog")).toBeVisible();
    await expect(local.locator("a#about-save-reader")).toBeVisible();
    const savingLocalCopy = local.waitForEvent("download");
    await local.locator("#about-save-reader").click();
    const localDownload = await savingLocalCopy;
    expect(await readFile((await localDownload.path())!)).toEqual(savedBytes);
    await local.locator("#close-about").click();
    const digest = createHash("sha256").update(savedBytes).digest("hex");
    const repository = "https://github.com/qecez/paperwarden";
    const tag = `sha256-${digest}`;
    const release = `${repository}/releases/tag/${tag}`;
    await expect(local.locator("#reader-build")).toHaveAttribute(
      "title",
      `Reader SHA-256: ${digest}`,
    );
    await local.screenshot({
      path: testInfo.outputPath("local-footer-390.png"),
      fullPage: true,
    });
    await local.locator("#reader-verify").focus();
    await local.locator("#reader-verify").press("Enter");
    await expect(local.locator("#check-dialog")).toBeVisible();
    await expect(local.locator("#published-checksum")).toBeVisible();
    await expect(local.locator("#published-checksum")).toHaveAttribute(
      "href",
      release,
    );
    const commands = local.locator(".verify-system code");
    await expect(commands).toHaveCount(3);
    for (const command of await commands.all())
      await expect(command).toBeVisible();
    for (const expected of [/shasum -a 256/, /sha256sum/, /Get-FileHash/])
      await expect(local.locator("#check-dialog")).toContainText(expected);
    await expect(local.locator("#published-checksum")).toHaveAttribute(
      "href",
      `${repository}/releases/tag/${tag}`,
    );
    await expect(local.locator("#reader-build")).toHaveText(
      `Build ${digest.slice(0, 12)}`,
    );
    await expect(local.locator("#reader-source")).toHaveAttribute(
      "href",
      `${repository}/tree/${tag}`,
    );
    await expect(local.locator("span#reader-build")).toHaveCount(1);
    await expect(local.locator("#reader-build")).not.toHaveAttribute("href");
    expect(
      await local.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await local.screenshot({
      path: testInfo.outputPath("local-verification-390.png"),
      fullPage: true,
    });
    await local.locator("#close-check").click();
    await expect(local.locator("#check-dialog")).toBeHidden();
    await expect(local.locator("#reader-verify")).toBeFocused();
    await expect(local).toHaveURL(fileUrl);

    // The independently generated Python fixture wraps its first record's nonce.
    expect(reference.rotation + 12).toBeGreaterThan(PAYLOAD_BYTES);
    const linked = encodeLink(
      new Uint8Array(Buffer.from(reference.hex, "hex")),
      "https://gone.invalid/",
    );
    await local.locator("#decrypt-tab").click();
    await local.locator("#encoded").fill(linked);

    await expect(local.locator("#loaded-backup-id")).toBeVisible();
    await expect(local.locator("#decrypt-form")).toBeVisible();
    for (const message of reference.messages) {
      await local.locator("#open-password").fill(message.password);
      await local.locator("#open-button").click();
      await expect(local.locator("#recovered")).toBeVisible();
      expect(await local.locator("#recovered-text").textContent()).toBe(
        message.text,
      );
      await expect(local.locator("#open-password")).toHaveValue("");
      await local.locator("#close-text").click();
      await expect(local.locator("#recovered-text")).toBeEmpty();
    }
    await expect(local).toHaveURL(fileUrl);

    await local.locator("#encrypt-tab").click();
    await expect(local.locator(".encryption-intro")).toHaveText(
      `${singleMessageIntro} Everything happens on this device.`,
    );
    await local.locator("#add-message").click();
    await expect(local.locator(".encryption-intro")).toHaveText(
      `${twoMessageIntro} Everything happens on this device.`,
    );
    await local.locator(".remove-message").click();
    await expect(local.locator("#encryption-summary")).toHaveText(
      singleMessageIntro,
    );

    await expect(local.locator("#reader-status")).toHaveAttribute(
      "data-context",
      "local",
    );
    await expect(local.locator("#local-copy")).toBeVisible();
    await expect(local.locator("#save-reader")).toBeHidden();
    await local.locator("[data-generate-password]").click();
    const offlinePassword = await local.locator("#password").inputValue();
    expect(offlinePassword).toMatch(/^[a-z]+(?: [a-z]+){7}$/);
    await expect(local.locator("#password")).toHaveAttribute("type", "text");
    await expect(local.locator("#reader-build")).toHaveAttribute(
      "title",
      `Reader SHA-256: ${digest}`,
    );
    await local.locator("#reader-verify").click();
    await expect(local.locator("#check-dialog")).toBeVisible();
    await expect(local.locator("#published-checksum")).toHaveAttribute(
      "href",
      release,
    );
    await local.locator("#close-check").click();
    await expect(local.locator("#password")).toHaveValue(offlinePassword);
    await expect(local.locator("#reader-build")).toHaveText(
      `Build ${digest.slice(0, 12)}`,
    );
    expect(
      await local.evaluate(() => [localStorage.length, sessionStorage.length]),
    ).toEqual([0, 0]);
    expect(await context.cookies()).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a fingerprint failure leaves local verification guidance without an identity or safety claim", async ({
  browser,
}, testInfo) => {
  const savedPath = testInfo.outputPath("fingerprint-unavailable.html");
  await writeFile(savedPath, await readFile("dist/paperwarden.html"));
  const context = await browser.newContext({ offline: true });
  await context.addInitScript(() => {
    Object.defineProperty(crypto.subtle, "digest", {
      value: () =>
        Promise.reject(
          new DOMException("Public digest failure", "OperationError"),
        ),
    });
  });
  const local = await context.newPage();
  const pageErrors: string[] = [];
  local.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    await local.goto(pathToFileURL(savedPath).href);
    await expect(local.locator("#reader-status")).toHaveAttribute(
      "data-context",
      "local",
    );
    await expect(local.locator("#reader-identity-unavailable")).toHaveCount(0);
    await local.locator("#reader-verify").focus();
    await local.locator("#reader-verify").press("Enter");
    await expect(local.locator("#check-dialog")).toBeVisible();
    await expect(local.locator("#reader-identity-unavailable")).toHaveCount(0);
    const commands = local.locator(".verify-system code");
    await expect(commands).toHaveCount(3);
    for (const command of await commands.all())
      await expect(command).toBeVisible();
    for (const expected of [/shasum -a 256/, /sha256sum/, /Get-FileHash/])
      await expect(local.locator("#check-dialog")).toContainText(expected);
    await expect(local.locator("#reader-build")).toHaveText(
      "Build unavailable",
    );
    await expect(local.locator("#save-reader")).toBeHidden();
    await expect(local.locator("#published-checksum")).toHaveAttribute(
      "href",
      "https://github.com/qecez/paperwarden/releases",
    );
    await local.locator("#close-check").click();
    await expect(local.locator("#reader-verify")).toBeFocused();
    await expect(local).toHaveURL(pathToFileURL(savedPath).href);
    await expect(local.locator("#reader-status")).not.toContainText(
      /checksum checks out|verified safe|safe to use|you are offline/i,
    );
    await local.locator("#encrypt-tab").click();
    await local.locator("#text").fill("Public hash-failure fixture");
    await expect(local.locator("#text")).toHaveValue(
      "Public hash-failure fixture",
    );
    await local.locator("#about").click();
    await expect(local.locator("#reader-build")).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a local build label identifies canonical download bytes rather than verifying the opened file", async ({
  browser,
}, testInfo) => {
  const canonical = await readFile("dist/paperwarden.html");
  // HTML parsing ignores whitespace before the doctype. The opened disk bytes
  // therefore differ while the app's canonical download serialization does not.
  const noncanonical = Buffer.concat([Buffer.from("\n"), canonical]);
  const digest = createHash("sha256").update(canonical).digest("hex");
  expect(createHash("sha256").update(noncanonical).digest("hex")).not.toBe(
    digest,
  );
  const savedPath = testInfo.outputPath("noncanonical-reader.html");
  await writeFile(savedPath, noncanonical);
  // A local URL remains a local copy even when the browser has connectivity.
  const context = await browser.newContext();
  const fileUrl = pathToFileURL(savedPath).href;
  const unexpectedRequests: string[] = [];
  context.on("request", (request) => {
    const url = request.url();
    if (url !== fileUrl && !/^(blob|data):/.test(url))
      unexpectedRequests.push(url);
  });
  const local = await context.newPage();
  try {
    await local.goto(fileUrl);
    await expect(local.locator("#reader-status")).toHaveAttribute(
      "data-context",
      "local",
    );
    await expect(local.locator("#local-copy")).toBeVisible();
    await expect(local.locator("#reader-build")).toHaveAttribute(
      "title",
      `Reader SHA-256: ${digest}`,
    );
    await local.locator("#reader-verify").click();
    await expect(local.locator("#check-dialog")).toBeVisible();
    await expect(local.locator("#published-checksum")).toHaveAttribute(
      "href",
      `https://github.com/qecez/paperwarden/releases/tag/sha256-${digest}`,
    );
    await expect(local.locator("#reader-status")).not.toContainText(
      /checksum checks out|verified safe|safe to use|you are offline/i,
    );
    expect(unexpectedRequests).toEqual([]);
  } finally {
    await context.close();
  }
});
