import { expect, test, type Page } from "@playwright/test";
import {
  BACKUP_BYTES,
  PREAMBLE,
  maximumTextBytes,
} from "../../src/format/constants";
import { encodeTransport } from "../../src/encoding/transport";

async function expectCapacityOrder(page: Page) {
  const layouts = await page.locator("[data-message]").evaluateAll((groups) =>
    groups.map((group) => {
      const text = group.querySelector("[data-text]")!;
      const capacity = group.querySelector("[data-capacity]")!;
      const password = group.querySelector("[data-password]")!;
      const label = group.querySelector(`label[for="${password.id}"]`)!;
      return {
        directlyAfterText: text.nextElementSibling === capacity,
        textBottom: text.getBoundingClientRect().bottom,
        capacityTop: capacity.getBoundingClientRect().top,
        capacityBottom: capacity.getBoundingClientRect().bottom,
        passwordLabelTop: label.getBoundingClientRect().top,
      };
    }),
  );
  for (const layout of layouts) {
    expect(layout.directlyAfterText).toBe(true);
    expect(layout.capacityTop).toBeGreaterThanOrEqual(layout.textBottom);
    expect(layout.passwordLabelTop).toBeGreaterThanOrEqual(
      layout.capacityBottom,
    );
  }
}

async function expectSharedCapacity(
  page: Page,
  count: number,
  used: number,
  status: string,
) {
  await expect(page.locator("[data-capacity]")).toHaveCount(count);
  const meters = await page.locator("[data-message]").evaluateAll((groups) =>
    groups.map((group) => {
      const container = group.querySelector("[data-capacity]")!;
      const meter = group.querySelector<HTMLMeterElement>(
        "[data-capacity-meter]",
      )!;
      const label = group.querySelector<HTMLLabelElement>(
        "[data-capacity-label]",
      )!;
      const status = group.querySelector("[data-capacity-status]")!;
      const text = group.querySelector("[data-text]")!;
      const references = text.getAttribute("aria-describedby")!.split(/\s+/);
      return {
        used: meter.value,
        maximum: meter.max,
        status: status.textContent,
        valueText: meter.getAttribute("aria-valuetext"),
        label: label.textContent!.trim(),
        overCapacity: container.classList.contains("over-capacity"),
        labelAssociates: label.htmlFor === meter.id,
        ownDescription:
          references.includes(label.id) &&
          references.includes(status.id) &&
          references.every(
            (id) => group.querySelectorAll(`[id="${id}"]`).length === 1,
          ),
        live: status.getAttribute("aria-live"),
      };
    }),
  );
  const maximum = maximumTextBytes(count);
  for (const [index, meter] of meters.entries()) {
    expect(meter).toEqual({
      used: Math.min(used, maximum),
      maximum,
      status,
      valueText: status,
      label: count === 1 ? "Backup space" : "Shared backup space",
      overCapacity: used > maximum,
      labelAssociates: true,
      ownDescription: true,
      live: index === 0 ? "polite" : null,
    });
  }
  expect(
    await page.locator("[id]").evaluateAll((elements) => {
      const ids = elements.map((element) => element.id);
      return new Set(ids).size === ids.length;
    }),
  ).toBe(true);
  await expect(
    page.getByRole("meter", {
      name: count === 1 ? "Backup space" : "Shared backup space",
      exact: true,
    }),
  ).toHaveCount(count);
  await expectCapacityOrder(page);
}

async function expectAddButtonFits(page: Page) {
  expect(
    await page.locator("#add-message").evaluate((button) => {
      const box = button.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(button);
      return (
        button.scrollWidth <= button.clientWidth &&
        Array.from(range.getClientRects()).every(
          (text) =>
            text.left >= box.left &&
            text.right <= box.right &&
            text.top >= box.top &&
            text.bottom <= box.bottom,
        ) &&
        document.documentElement.scrollWidth <= window.innerWidth
      );
    }),
  ).toBe(true);
}

async function expectPasswordControlsSeparated(page: Page, inputId: string) {
  const layout = await page.evaluate((id) => {
    const input = document.getElementById(id)!;
    const toggle = document.querySelector(`[data-show="${id}"]`)!;
    const a = input.getBoundingClientRect();
    const b = toggle.getBoundingClientRect();
    return {
      overlap:
        Math.min(a.right, b.right) > Math.max(a.left, b.left) &&
        Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top),
      inputWidth: a.width,
      toggleWidth: b.width,
    };
  }, inputId);
  expect(layout.overlap).toBe(false);
  expect(layout.inputWidth).toBeGreaterThan(60);
  expect(layout.toggleWidth).toBeGreaterThan(60);
  await page.locator(`[data-show="${inputId}"]`).click();
  await expect(page.locator(`#${inputId}`)).toHaveAttribute("type", "text");
  const revealedWidth = await page
    .locator(`#${inputId}`)
    .evaluate((node) => node.getBoundingClientRect().width);
  expect(revealedWidth).toBeCloseTo(layout.inputWidth, 1);
  await page.locator(`[data-show="${inputId}"]`).click();
}

for (const width of [1280, 320]) {
  test(`capacity and password controls remain ordered without overlap at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expectCapacityOrder(page);
    await expectPasswordControlsSeparated(page, "password");

    await expectSharedCapacity(page, 1, 0, "0% used");
    const texts = ["🌿é", "保持", "ééé", "aaaaaa"]; // Six UTF-8 bytes each.
    for (let index = 0; index < texts.length; index++) {
      if (index) await page.locator("#add-message").click();
      await page
        .locator("[data-message] [data-text]")
        .nth(index)
        .fill(texts[index]);
      await expectSharedCapacity(
        page,
        index + 1,
        6 * (index + 1),
        "Less than 1% used",
      );
      await expectAddButtonFits(page);
    }
    await expect(page.locator("#add-message")).toBeDisabled();
    const maximum = maximumTextBytes(4);
    await page
      .locator("[data-message] [data-text]")
      .last()
      .fill("x".repeat(maximum - 18));
    await expectSharedCapacity(page, 4, maximum, "Full");
    await page
      .locator("[data-message] [data-text]")
      .last()
      .fill("x".repeat(maximum - 17));
    await expectSharedCapacity(
      page,
      4,
      maximum + 1,
      "Over capacity — shorten your text",
    );
    await expectAddButtonFits(page);

    // Removing and adding again must not leave stale values or reused ARIA IDs.
    await page.locator(".remove-message").last().click();
    await expectSharedCapacity(page, 3, 18, "Less than 1% used");
    await page.locator("#add-message").click();
    await expectSharedCapacity(page, 4, 18, "Less than 1% used");
    await page.locator("#clear-create").click();
    await expectSharedCapacity(page, 1, 0, "0% used");
    await expect(page.locator("#text")).toHaveValue("");
    await expectAddButtonFits(page);

    // Public structural bytes exercise the pre-password UI without doing a KDF.
    const bytes = new Uint8Array(BACKUP_BYTES);
    bytes.set(PREAMBLE);
    await page.locator("#decrypt-tab").click();
    await page.locator("#paste").click();
    await page.locator("#encoded").fill(encodeTransport(bytes));
    await page.locator("#paste-form button").click();
    await expect(page.locator("#loaded-backup-id")).toBeVisible();
    await expect(page.locator("#decrypt-form")).toBeVisible();
    await expectPasswordControlsSeparated(page, "open-password");
    const recovery = await page.evaluate(() => {
      const id = document.getElementById("loaded-backup-id")!;
      const password = document.getElementById("open-password")!;
      const row = password.closest(".password-row")!;
      const button = document.getElementById("open-button")!;
      return {
        idOutsideForm: id.closest("#decrypt-form") === null,
        idBottom: id.getBoundingClientRect().bottom,
        passwordTop: password.getBoundingClientRect().top,
        rowBottom: row.getBoundingClientRect().bottom,
        buttonTop: button.getBoundingClientRect().top,
        noHorizontalOverflow:
          document.documentElement.scrollWidth <= window.innerWidth,
      };
    });
    expect(recovery.idOutsideForm).toBe(true);
    expect(recovery.passwordTop).toBeGreaterThanOrEqual(recovery.idBottom);
    expect(recovery.buttonTop - recovery.rowBottom).toBeGreaterThanOrEqual(8);
    expect(recovery.noHorizontalOverflow).toBe(true);
    await expect(page.locator("#loaded-backup-id")).toHaveText(
      /^Backup ID: [a-z]+(?: [a-z]+){5}$/,
    );
    await expect(page.locator("#loaded-backup-id")).toHaveCSS(
      "font-style",
      "italic",
    );
  });
}
