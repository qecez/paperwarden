import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { encryptEnvelope } from "../../src/format/envelope";
import { decodeArchive, encodeArchive } from "../../src/encoding/archive";
import { encodeTransport } from "../../src/encoding/transport";
import { formatShortBackupId } from "../../src/encoding/backup-id";
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
    text: "\uFEFFSecond public test message.\nCafé 保持",
    password: "public river maple stone 2",
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
  await expect(page.locator("#recovered-heading")).toBeFocused();
  for (const selector of [
    "#decrypt-heading",
    "#loaded-backup-id",
    "#decrypt-form",
    "#input-methods",
  ])
    await expect(page.locator(selector)).toBeHidden();
  expect(await page.locator("#recovered-text").textContent()).toBe(text);
  await expect(page.locator("#open-password")).toHaveValue("");
}
async function loadText(page: Page, text: string) {
  if (await page.locator("#load-another").isVisible())
    await page.locator("#load-another").click();
  else if (await page.locator("#change-backup").isVisible())
    await page.locator("#change-backup").click();
  await expect(page.locator("#input-methods")).toBeVisible();
  await page.locator("#encoded").fill(text);

  await expect(page.locator("#decrypt-form")).toBeVisible();
  await expect(page.locator("#paste-form")).toBeHidden();
  await expect(page.locator("#encoded")).toHaveValue("");
  await expect(page.locator("#input-methods")).toBeHidden();
  await expect(page.locator("#load-another")).toBeHidden();
  await expect(page.locator("#change-backup")).toBeVisible();
  await expect(page.locator("#open-button")).toHaveText("Decrypt backup");
  await expect(page.locator("#recovered-text")).toHaveText("");
}
async function elementWidth(page: Page, selector: string) {
  return page
    .locator(selector)
    .evaluate((node) => node.getBoundingClientRect().width);
}

test("local password actions keep validation and Enter without a leave-page warning", async ({
  page,
  browserName,
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
  // WebKit's protocol close with runBeforeUnload may leave the page open.
  // Navigation exercises the same beforeunload path before a normal close.
  if (browserName === "webkit") await page.goto("about:blank");
  await page.close({ runBeforeUnload: browserName !== "webkit" });
  await expect.poll(() => page.isClosed()).toBe(true);
  expect(dialogs).toEqual([]);
});

test("one text loader recognizes raw and archival transports and keeps corruption checks", async ({
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
    await expect(page.locator("#input-methods")).toBeHidden();
    await expect(page.locator("#load-another")).toBeVisible();
  }
  await page.locator("#load-another").click();
  await expect(page.locator("#encoded")).toBeFocused();
  await expect(page.locator("#encoded")).toHaveValue("");
  await expect(page.locator("#recovered-text")).toBeEmpty();
  await expect(page.locator("#loaded-backup-id")).toBeHidden();
  await expect(page.locator("#open-password")).toHaveValue("");
  for (const text of [transport + " ", archive.replace("001 ", "002 ")]) {
    await page.locator("#encoded").fill(text);

    await expect(page.locator("#decrypt-error")).toBeVisible();
    await expect(page.locator("#decrypt-form")).toBeHidden();
    await expect(page.locator("#recovered-text")).toHaveText("");
  }
  // A new import replaces the previously recovered backup after the explicit reset.
  const replacement = await encryptEnvelope([messages[1]]);
  await loadText(page, encodeTransport(replacement));
  await recover(page, messages[1].password, messages[1].text);
});

test("Change backup clears a mistaken import and recovery output replaces the prompt", async ({
  page,
}) => {
  const original = await encryptEnvelope([messages[0]]);
  const replacement = await encryptEnvelope([messages[1]]);
  const label = (bytes: Uint8Array) =>
    formatShortBackupId(createHash("sha256").update(bytes).digest("hex"));
  await page.goto("/");
  await page.locator("#decrypt-tab").click();
  await loadText(page, encodeTransport(original));
  await expect(page.locator("#loaded-backup-id")).toHaveText(
    `Backup ${label(original)} loaded.`,
  );
  await expect(page.locator("#loaded-backup-id em")).toHaveText(
    label(original),
  );
  await page.locator("#open-password").fill("wrong public fixture password");
  await page.locator("#open-button").click();
  await expect(page.locator("#decrypt-error")).toBeVisible();
  await page.locator('[data-show="open-password"]').click();
  await page.locator("#open-password").fill("discard this public password");
  await page.locator("#change-backup").click();
  await expect(page.locator("#encoded")).toBeFocused();
  await expect(page.locator("#encoded")).toHaveValue("");
  await expect(page.locator("#input-methods")).toBeVisible();
  await expect(page.locator("#decrypt-heading")).toBeVisible();
  await expect(page.locator("#decrypt-form")).toBeHidden();
  await expect(page.locator("#loaded-backup-id")).toBeEmpty();
  await expect(page.locator("#loaded-backup-id")).toBeHidden();
  await expect(page.locator("#decrypt-error")).toBeEmpty();
  await expect(page.locator("#open-password")).toHaveValue("");
  await expect(page.locator("#open-password")).toHaveAttribute(
    "type",
    "password",
  );
  await expect(page.locator("#recovered-text")).toBeEmpty();
  await loadText(page, encodeTransport(replacement));
  await expect(page.locator("#loaded-backup-id")).toHaveText(
    `Backup ${label(replacement)} loaded.`,
  );
  await recover(page, messages[1].password, messages[1].text);
  await expect(page.locator("#load-another")).not.toHaveClass(/quiet/);
  await page.locator("#close-text").click();
  await expect(page.locator("#recovered")).toBeHidden();
  await expect(page.locator("#recovered-text")).toBeEmpty();
  await expect(page.locator("#decrypt-heading")).toBeVisible();
  await expect(page.locator("#loaded-backup-id")).toHaveText(
    `Backup ${label(replacement)} loaded.`,
  );
  await expect(page.locator("#open-password")).toBeFocused();
  await expect(page.locator("#open-password")).toHaveValue("");
  await recover(page, messages[1].password, messages[1].text);
  await page.locator("#load-another").click();
  await expect(page.locator("#encoded")).toBeFocused();
  await expect(page.locator("#loaded-backup-id")).toBeEmpty();
  await expect(page.locator("#recovered-text")).toBeEmpty();
});

test("new passwords require seven normalized characters without restricting recovery", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#text").fill("Public minimum-password test message");
  // Count Unicode code points after NFC, rather than UTF-16 units or UTF-8 bytes.
  for (const [index, password] of [
    "abcdef",
    "🔒".repeat(6),
    "e\u0301abcde",
  ].entries()) {
    await page.locator("#password").fill(password);
    // Cover pointer activation first, then keyboard activation while native
    // validation UI may still be covering the button in Linux Firefox.
    if (index === 0) await page.locator("#encrypt-button").click();
    else await page.locator("#encrypt-button").press("Space");
    await expect(page.locator("#backup-result")).toBeHidden();
    await expect(page.locator("#password")).toBeFocused();
    await expect
      .poll(() =>
        page.locator("#password").evaluate((input: HTMLInputElement) => ({
          valid: input.validity.valid,
          message: input.validationMessage,
        })),
      )
      .toEqual({ valid: false, message: expect.stringContaining("7") });
    await page.locator("#password").press("Escape");
  }
  await page.locator("#password").fill("e\u0301abcdef");
  await page.locator("#encrypt-button").press("Space");
  await expect(page.locator("#backup-result")).toBeVisible();
  await expect(page.locator("#backup-storage")).toContainText(
    "your password to open it",
  );
  await expect(page.locator("#main")).toHaveAttribute("aria-busy", "false");

  await page.locator("#add-message").click();
  const second = page.locator("[data-message]").nth(1);
  await second.locator("[data-text]").fill("Public second message");
  await second.locator("[data-password]").fill("abcdef");
  await page.locator("#encrypt-button").click();
  await expect(second.locator("[data-password]")).toBeFocused();
  await expect(page.locator("#backup-result")).toBeHidden();
  await second.locator("[data-password]").press("Escape");
  // Generation must also clear the previous field validation failure.
  await second.locator("[data-generate-password]").click();
  await expect(second.locator("[data-password]")).toHaveValue(
    /^[a-z]+(?: [a-z]+){7}$/,
  );
  await generate(page);
  await expect(page.locator("#backup-storage")).toContainText(
    "your passwords to open it",
  );

  const shorter = {
    text: "Public short-password recovery fixture",
    password: "abcdef",
  };
  const backup = await encryptEnvelope([shorter]);
  await page.locator("#decrypt-tab").click();
  await loadText(page, encodeTransport(backup));
  await recover(page, shorter.password, shorter.text);
});

// Public fixtures only: never use real private backups in browser artifacts.
test("independent messages share one fixed backup and the saved reader stays clean", async ({
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
    page.locator(
      "#clear-open, #choose-file, #backup-file, #save-binary, #pdf, #clear-create, #paste",
    ),
  ).toHaveCount(0);
  await expect(
    page.getByText("Save an encrypted copy", { exact: true }),
  ).toHaveCount(0);
  await enterMessages(page, MAX_MESSAGES);
  await expect(page.locator("[data-message]")).toHaveCount(2);
  await expect(page.locator("#add-message")).toBeHidden();
  await expect(page.locator("#message-limit")).toHaveText(
    "Both messages share the same backup space.",
  );
  // Even a synthetic click cannot add another fieldset beyond the limit.
  await page.locator("#add-message").dispatchEvent("click");
  await expect(page.locator("[data-message]")).toHaveCount(2);
  // Check the lock in the same turn that starts encryption, before a worker
  // can finish. Synthetic events must not remove fields during active work.
  const removalDuringEncryption = await page.evaluate(() => {
    document.getElementById("encrypt-button")!.click();
    const remove = document.getElementById(
      "remove-message",
    ) as HTMLButtonElement;
    const disabled = remove.disabled;
    remove.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return {
      disabled,
      busy: document.getElementById("main")!.getAttribute("aria-busy"),
      messageCount: document.querySelectorAll("[data-message]").length,
    };
  });
  expect(removalDuringEncryption).toEqual({
    disabled: true,
    busy: "true",
    messageCount: 2,
  });
  await expect(page.locator("#backup-result")).toBeVisible();
  await expect(page.locator("#main")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#remove-message")).toBeEnabled();
  const textPromise = page.waitForEvent("download");
  await page.locator("#save-text").click();
  const textDownload = await textPromise;
  expect(textDownload.suggestedFilename()).toBe(
    `${formatShortBackupId(
      createHash("sha256")
        .update(
          await decodeArchive(
            await readFile((await textDownload.path())!, "utf8"),
          ),
        )
        .digest("hex"),
    ).replaceAll(" ", "-")}.txt`,
  );
  const encryptedText = await readFile((await textDownload.path())!, "utf8");
  expect((await decodeArchive(encryptedText)).length).toBe(BACKUP_BYTES);
  expect(encryptedText.match(/^\d{3} /gm)).toHaveLength(115);
  await expect(page.locator("#print-root")).toHaveCount(0);
  await expect(page.locator("#save-text")).toHaveText("Save as text");
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
    await expect(page.locator("#decrypt-heading")).toBeVisible();
    await expect(page.locator("#loaded-backup-id")).toBeVisible();
    await expect(page.locator("#decrypt-form")).toBeVisible();
    await expect(page.locator("#open-password")).toBeFocused();
    await expect(page.locator("#input-methods")).toBeHidden();
  }
  expect(
    await page.evaluate(() => [localStorage.length, sessionStorage.length]),
  ).toEqual([0, 0]);
  expect(external).toEqual([]);

  // Reopen exactly the downloaded bytes in a fresh context. This deliberately
  // exercises HTTP delivery, not file:// compatibility or physical scanning.
  const isolated = await browser.newContext();
  const isolatedRequests: string[] = [];
  // WebKit also routes local Blob workers; only network URLs belong here.
  await isolated.route(/^https?:\/\//, async (route) => {
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
    await recover(saved, messages[1].password, messages[1].text);
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
  await expect(page.locator("#backup-result")).toBeHidden();
  await expect(page.locator("#qr")).not.toHaveAttribute("src");
  await expect(page.locator("#print")).toBeDisabled();
  await expect(page.locator("#print-root")).toHaveCount(0);
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
  await page.reload();
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

for (const [name, selector, action] of [
  ["main message", "#text", "input"],
  ["main password", "#password", "input"],
  ["additional message", ".additional-message [data-text]", "input"],
  ["additional password", ".additional-message [data-password]", "input"],
  ["message added", "#add-message", "click"],
  ["message removed", ".remove-message", "click"],
] as const) {
  test(`editing ${name} discards the generated QR and every export`, async ({
    page,
  }) => {
    await page.goto("/");
    await enterMessages(page, name === "message added" ? 1 : 2);
    await generate(page);
    await page.locator('[data-show="password"]').click();
    await expect(page.locator("#backup-result")).toBeVisible();
    if (action === "input")
      await page.locator(selector).fill("Changed public fixture");
    else await page.locator(selector).click();
    await expect(page.locator("#backup-result")).toBeHidden();
    await expect(page.locator("#qr")).not.toHaveAttribute("src");
    await expect(page.locator("#backup-id")).toHaveCount(0);
    await expect(page.locator("#backup-storage")).toBeEmpty();
    await expect(page.locator("#print-root")).toHaveCount(0);
    await expect(page.locator("#print")).toBeDisabled();
    await expect(page.locator("#save-text")).toBeDisabled();
    await page.locator("#decrypt-tab").click();
    await page.locator("#encrypt-tab").click();
    await expect(page.locator("#backup-result")).toBeHidden();
  });
}

test("local verification guidance preserves recovery state and identifies the exact reader", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.screenshot({
    path: testInfo.outputPath("hosted-footer-desktop.png"),
    fullPage: true,
  });
  const encrypted = await encryptEnvelope(messages.slice(0, 1));
  await page.locator("#decrypt-tab").click();
  await page.locator("#encoded").fill(encodeTransport(encrypted));

  await expect(page.locator("#loaded-backup-id")).toBeVisible();
  const loadedId = await page.locator("#loaded-backup-id").textContent();
  await page.locator("#open-password").fill(messages[0].password);
  const recoveryUrl = page.url();
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.locator("#reader-verify").focus();
  await page.locator("#reader-verify").press("Enter");
  await expect(page.locator("#check-dialog")).toBeVisible();
  await expect(page.locator("#published-checksum")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("verification-guide-desktop.png"),
    fullPage: true,
  });
  await expect(page).toHaveURL(recoveryUrl);
  await page.locator("#close-check").click();
  await expect(page.locator("#check-dialog")).toBeHidden();
  await expect(page.locator("#reader-verify")).toBeFocused();
  await expect(page.locator("#loaded-backup-id")).toHaveText(loadedId!);
  await expect(page.locator("#open-password")).toHaveValue(
    messages[0].password,
  );
  await page.locator("#open-button").click();
  await expect(page.locator("#recovered-text")).toHaveText(messages[0].text);
  await page.locator("#about").click();
  await expect(page).toHaveURL(recoveryUrl);
  await expect(page.locator("#recovered-text")).toHaveText(messages[0].text);
  const bytes = await readFile("dist/paperwarden.html");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const expectedUrl = `https://github.com/qecez/paperwarden/releases/tag/sha256-${digest}`;
  await expect(page.locator("#published-checksum")).toHaveAttribute(
    "href",
    expectedUrl,
  );
  const headings = await page.locator("#about-dialog h3").allTextContents();
  expect(headings).toEqual([
    "Why paper?",
    "Make and recover a backup",
    "Using it safely",
  ]);
  await expect(page.locator("header .version")).toHaveCount(0);
  expect(await readFile("dist/paperwarden.html.sha256", "utf8")).toBe(
    `${digest}  paperwarden.html\n`,
  );
  await expect(page.locator("#published-checksum")).toHaveAttribute(
    "target",
    "_blank",
  );
  await expect(page.locator("#published-checksum")).toHaveAttribute(
    "rel",
    "noopener noreferrer",
  );
  const buildLabel = page.locator("span#reader-build");
  await expect(buildLabel).toHaveCount(1);
  await expect(buildLabel).not.toHaveAttribute("href");
  await expect(
    page.getByRole("link", { name: `Build ${digest.slice(0, 12)}` }),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Source code" })).toHaveAttribute(
    "href",
    `https://github.com/qecez/paperwarden/tree/sha256-${digest}`,
  );
  await expect(page.locator("#reader-build")).toHaveText(
    `Build ${digest.slice(0, 12)}`,
  );
  await page.locator("#close-about").click();
  await expect(page.locator("#recovered")).toBeVisible();
  await expect(page.locator("#recovered-text")).toHaveText(messages[0].text);
  await page.locator("#encrypt-tab").click();
  await page
    .locator("#text")
    .fill("Public test text is not part of the reader identity");
  await page.locator("#password").fill("public test password");
  await expect(page.locator("#reader-status")).toHaveAttribute(
    "data-context",
    "hosted",
  );
  await page.locator("#reader-verify").click();
  await expect(page.locator("#check-dialog")).toBeVisible();
  await expect(page.locator("#reader-build")).toHaveAttribute(
    "title",
    `Reader SHA-256: ${digest}`,
  );
  await expect(page.locator("#published-checksum")).toHaveAttribute(
    "href",
    `https://github.com/qecez/paperwarden/releases/tag/sha256-${digest}`,
  );
  await page.locator("#close-check").click();
  await expect(page.locator("#text")).toHaveValue(
    "Public test text is not part of the reader identity",
  );
  await expect(page.locator("#password")).toHaveValue("public test password");
  expect(requests.filter((url) => !/^(blob|data):/.test(url))).toEqual([]);
  const downloading = page.waitForEvent("download");
  await page.locator("#save-reader").click();
  const saved = await downloading;
  expect(await readFile((await saved.path())!)).toEqual(bytes);
});

test("password toggles, tabs, keyboard, narrow layout, and About remain accessible", async ({
  page,
}, testInfo) => {
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
  await expect(
    page.getByText("Technical details", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator("#about-dialog .dialog-content > p")
      .filter({ hasText: "has not had an independent security audit" }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const headingTop = await page
    .locator("#about-dialog .dialog-heading")
    .evaluate((node) => node.getBoundingClientRect().top);
  await page.locator("#about-dialog .dialog-content").press("End");
  expect(
    await page
      .locator("#about-dialog .dialog-heading")
      .evaluate((node) => node.getBoundingClientRect().top),
  ).toBe(headingTop);
  await page.keyboard.press("Escape");
  await expect(page.locator("#about-dialog")).not.toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  await page.screenshot({
    path: testInfo.outputPath("hosted-footer-320.png"),
    fullPage: true,
  });
  await page.locator("#reader-verify").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#check-dialog")).toBeVisible();
  await expect(page.locator("#close-check")).toBeFocused();
  await expect(page.locator(".verify-system code")).toHaveCount(3);
  for (const command of await page.locator(".verify-system code").all())
    await expect(command).toBeVisible();
  expect(
    await page.locator("#check-dialog").evaluate((dialog) => {
      const rect = dialog.getBoundingClientRect();
      const content = dialog.querySelector(".dialog-content")!;
      return (
        rect.left >= 0 &&
        rect.right <= innerWidth &&
        dialog.scrollWidth <= dialog.clientWidth &&
        content.scrollWidth <= content.clientWidth
      );
    }),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("verification-guide-320.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(page.locator("#check-dialog")).toBeHidden();
  await expect(page.locator("#reader-verify")).toBeFocused();
  await page.locator("#encrypt-tab").click();
  await enterMessages(page, 2);
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

test("switching views cancels a pending job without publishing its late result", async ({
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
  await expect(page.locator("#add-message")).toBeDisabled();
  await page.locator("#decrypt-tab").click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-test-reply-delivered",
    "true",
  );
  await expect(page.locator("#main")).toHaveAttribute("aria-busy", "false");
  await page.locator("#encrypt-tab").click();
  await expect(page.locator("#text")).toHaveValue(messages[0].text);
  await expect(page.locator("#password")).toHaveValue(messages[0].password);
  await expect(page.locator("#add-message")).toBeEnabled();
  await expect(page.locator("#backup-result")).not.toBeVisible();
  await expect(page.locator("#print-root")).toHaveCount(0);
  await expect(page.locator("#encrypt-error")).not.toBeVisible();
});

for (const cancellation of ["switch view", "change backup"] as const) {
  test(`${cancellation} cancels decryption and cannot reveal a late reply`, async ({
    page,
  }) => {
    const encrypted = await encryptEnvelope(messages.slice(0, 1));
    await page.addInitScript((text) => {
      class HeldWorker {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror = null;
        onmessageerror = null;
        postMessage() {
          const callback = this.onmessage;
          (window as unknown as { releaseDecrypt: () => void }).releaseDecrypt =
            () => {
              callback?.({
                data: { ok: true, value: { text } },
              } as MessageEvent);
              document.documentElement.dataset.decryptReplyDelivered = "true";
            };
        }
        terminate() {
          /* Retain an already queued reply to exercise cancellation. */
        }
      }
      window.Worker = HeldWorker as unknown as typeof Worker;
    }, messages[0].text);
    await page.goto("/");
    await page.locator("#decrypt-tab").click();
    await loadText(page, encodeTransport(encrypted));
    await page.locator("#open-password").fill(messages[0].password);
    await page.locator("#open-button").click();
    await expect(page.locator("#main")).toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#load-another")).toBeHidden();
    await expect(page.locator("#change-backup")).toBeDisabled();
    if (cancellation === "switch view")
      await page.locator("#encrypt-tab").click();
    else
      // Exercise a queued activation: the normal UI disables this control while busy.
      await page.locator("#change-backup").dispatchEvent("click");
    await expect(page.locator("#open-password")).toHaveValue("");
    await page.evaluate(() => {
      (window as unknown as { releaseDecrypt: () => void }).releaseDecrypt();
    });
    await expect(page.locator("html")).toHaveAttribute(
      "data-decrypt-reply-delivered",
      "true",
    );
    await expect(page.locator("#main")).toHaveAttribute("aria-busy", "false");
    await expect(page.locator("#recovered-text")).toBeEmpty();
    await expect(page.locator("#recovered")).toBeHidden();
    await expect(page.locator("#decrypt-form")).toBeHidden();
    await page.locator("#decrypt-tab").click();
    if (cancellation === "switch view") {
      await expect(page.locator("#input-methods")).toBeHidden();
      await expect(page.locator("#decrypt-form")).toBeVisible();
    } else {
      await expect(page.locator("#input-methods")).toBeVisible();
      await expect(page.locator("#decrypt-form")).toBeHidden();
      await expect(page.locator("#loaded-backup-id")).toBeEmpty();
    }
    await expect(page.locator("#open-password")).toHaveValue("");
    await expect(page.locator("#recovered")).toBeHidden();
    await expect(page.locator("#load-another")).toBeHidden();
  });
}

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
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: async () => stream },
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
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () =>
          new Promise<MediaStream>((resolve) => {
            document.documentElement.dataset.testCameraPending = "true";
            document.addEventListener(
              "test-release-camera",
              () => resolve(stream),
              { once: true },
            );
          }),
      },
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
