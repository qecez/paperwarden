import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import words from "../../src/encoding/wordlists/bip39-english.json" with { type: "json" };

// Generated passwords and messages here are disposable test data only.
test("password generation is deliberate, independent, offline, and absent from the saved app", async ({
  page,
}) => {
  await page.goto("/");
  await page.context().setOffline(true);
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const generated: string[] = [];
  for (let index = 0; index < 2; index++) {
    if (index) await page.locator("#add-message").click();
    const group = page.locator("[data-message]").nth(index);
    const input = group.locator("[data-password]");
    await expect(input).toHaveValue("");
    await expect(input).toHaveAttribute("type", "password");
    await group.locator("[data-generate-password]").click();
    const password = await input.inputValue();
    const parts = password.split(" ");
    expect(parts).toHaveLength(8);
    expect(parts.every((word) => words.includes(word))).toBe(true);
    expect(generated).not.toContain(password);
    generated.push(password);
    for (let previous = 0; previous <= index; previous++) {
      await expect(page.locator("[data-password]").nth(previous)).toHaveValue(
        generated[previous],
      );
    }
    await expect(input).toHaveAttribute("type", "text");
    const toggle = group.locator("[data-show]");
    await expect(toggle).toHaveAccessibleName("Hide password");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(group.locator("[data-password-status]")).toContainText(
      "Record all eight words",
    );
    await toggle.click();
    await expect(input).toHaveAttribute("type", "password");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
  }
  const saving = page.waitForEvent("download");
  await page.locator("#save-reader").click();
  const reader = await readFile((await (await saving).path())!);
  expect(reader).toEqual(await readFile("dist/paperwarden.html"));
  for (const password of generated)
    expect(reader.toString()).not.toContain(password);
  expect(
    await page.evaluate(() => [localStorage.length, sessionStorage.length]),
  ).toEqual([0, 0]);
  expect(requests).toEqual([]);

  // Manual passwords remain supported, and no stale generation claim survives an edit.
  await page
    .locator("[data-password]")
    .first()
    .fill("public custom password kept intact");
  await expect(page.locator("[data-password-status]").first()).toBeHidden();
  await page.locator(".remove-message").first().click();
  await expect(page.locator("[data-message]")).toHaveCount(1);
  await expect(page.locator("#password")).toHaveAccessibleName("Password");
  await expect(page.locator("#password")).toHaveValue(
    "public custom password kept intact",
  );
  await expect(page.locator("[data-generate-password]")).toHaveAccessibleName(
    "Generate password",
  );
  await page.locator("#add-message").click();
  await expect(page.getByLabel("Second password", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    page.locator("[data-generate-password]").nth(1),
  ).toHaveAccessibleName("Generate password for second message");
  await expect(page.locator("[data-password]").first()).toHaveValue(
    "public custom password kept intact",
  );
});

test("generating either message's password clears every stale export and cannot run during encryption", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#add-message").click();
  for (let index = 0; index < 2; index++) {
    const group = page.locator("[data-message]").nth(index);
    await group.locator("[data-text]").fill(`Public test message ${index}`);
    await group.locator("[data-generate-password]").click();
  }
  for (let index = 0; index < 2; index++) {
    const button = page.locator("[data-generate-password]").nth(index);
    const input = page.locator("[data-password]").nth(index);
    const original = await input.inputValue();
    await page.locator("#encrypt-button").click();
    await expect(button).toBeDisabled();
    // Synthetic dispatch bypasses native disabled click suppression. The handler
    // must still respect the busy state and the ancestor fieldset's disability.
    await button.dispatchEvent("click");
    await expect(input).toHaveValue(original);
    await expect(page.locator("#backup-result")).toBeVisible();
    await expect(button).toBeEnabled();
    await button.click();
    expect(await input.inputValue()).not.toBe(original);
    await expect(page.locator("#backup-result")).toBeHidden();
    await expect(page.locator("#qr")).not.toHaveAttribute("src");
    await expect(page.locator("#backup-id")).toHaveCount(0);
    await expect(page.locator("#print-root")).toHaveCount(0);
    for (const exportButton of await page.locator("[data-export]").all()) {
      await expect(exportButton).toBeDisabled();
    }
  }
});

test("entropy failure reports the problem without replacing a password or its backup", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#text").fill("Public entropy failure test message");
  await page.locator("#password").fill("public original password");
  await page.locator("#encrypt-button").click();
  await expect(page.locator("#backup-result")).toBeVisible();
  const qr = await page.locator("#qr").getAttribute("src");
  await page.evaluate(() => {
    crypto.getRandomValues = () => {
      throw new Error("Public test entropy failure");
    };
  });
  await page.locator("[data-generate-password]").click();
  await expect(page.locator("#encrypt-error")).toContainText(
    "could not generate a secure password",
  );
  await expect(page.locator("#password")).toHaveValue(
    "public original password",
  );
  await expect(page.locator("#password")).toHaveAttribute("type", "password");
  await expect(page.locator("#backup-result")).toBeVisible();
  await expect(page.locator("#qr")).toHaveAttribute("src", qr!);
  await expect(page.locator("#save-text")).toBeEnabled();
});

test("both password generators fit at 320px and are keyboard accessible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 850 });
  await page.goto("/");
  for (let index = 0; index < 2; index++) {
    if (index) await page.locator("#add-message").click();
    const group = page.locator("[data-message]").nth(index);
    const button = group.locator("[data-generate-password]");
    await button.focus();
    await page.keyboard.press("Space");
    await expect(group.locator("[data-password]")).toHaveValue(
      /^[a-z]+(?: [a-z]+){7}$/,
    );
    const fits = await group.evaluate((node) => {
      const row = node.querySelector(".password-row")!.getBoundingClientRect();
      const button = node.querySelector("[data-generate-password]")!;
      const box = button.getBoundingClientRect();
      const input = node
        .querySelector("[data-password]")!
        .getBoundingClientRect();
      const toggle = node.querySelector("[data-show]")!.getBoundingClientRect();
      const icon = button.querySelector("svg")!.getBoundingClientRect();
      return (
        box.top >= row.top &&
        box.bottom <= row.bottom &&
        input.right <= box.left &&
        box.right <= toggle.left &&
        box.width >= 44 &&
        box.height >= 44 &&
        icon.left >= box.left + 8 &&
        icon.right <= box.right - 8 &&
        icon.top >= box.top + 8 &&
        icon.bottom <= box.bottom - 8 &&
        button.scrollWidth <= button.clientWidth &&
        document.documentElement.scrollWidth <= window.innerWidth
      );
    });
    expect(fits).toBe(true);
    const toggle = group.locator("[data-show]");
    expect(
      await toggle.evaluate((node) =>
        parseFloat(getComputedStyle(node).paddingLeft),
      ),
    ).toBeGreaterThanOrEqual(8);
    await toggle.click();
    await expect(group.locator("[data-password]")).toHaveAttribute(
      "type",
      "password",
    );
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
