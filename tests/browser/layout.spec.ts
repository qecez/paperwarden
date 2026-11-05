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
  for (const [index, ordinal] of ["First", "Second"]
    .slice(0, count)
    .entries()) {
    const group = page.locator("[data-message]").nth(index);
    await expect(group.locator("[data-text]")).toHaveAccessibleName(
      count === 1 ? "Message" : `${ordinal} message`,
    );
    await expect(group.locator("[data-password]")).toHaveAccessibleName(
      count === 1 ? "Password" : `${ordinal} password`,
    );
    await expect(
      group.locator("[data-generate-password]"),
    ).toHaveAccessibleName(
      count === 1
        ? "Generate password"
        : `Generate password for ${ordinal.toLowerCase()} message`,
    );
    if (index > 0)
      await expect(
        page.locator("#encrypt-actions > .remove-message"),
      ).toHaveAccessibleName(`Remove message: ${ordinal.toLowerCase()}`);
  }
}

async function expectActionButtonsFit(page: Page) {
  expect(
    await page
      .locator("#add-message:visible, #encrypt-actions button:visible")
      .evaluateAll(
        (buttons) =>
          buttons.every((button) => {
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
              )
            );
          }) && document.documentElement.scrollWidth <= window.innerWidth,
      ),
  ).toBe(true);
}

async function expectPasswordControlsSeparated(page: Page, inputId: string) {
  const layout = await page.evaluate((id) => {
    const input = document.getElementById(id)!;
    const toggle = document.querySelector(`[data-show="${id}"]`)!;
    const generate = document.querySelector(`[data-generate-password="${id}"]`);
    const a = input.getBoundingClientRect();
    const b = toggle.getBoundingClientRect();
    return {
      overlap:
        Math.min(a.right, b.right) > Math.max(a.left, b.left) &&
        Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top),
      inputWidth: a.width,
      toggleWidth: b.width,
      toggleHeight: b.height,
      generationFirst:
        !generate ||
        (input.nextElementSibling === generate &&
          generate.nextElementSibling === toggle),
      generationFits:
        !generate ||
        (generate.getBoundingClientRect().left >= a.right &&
          generate.getBoundingClientRect().right <= b.left),
      iconInset: (() => {
        const icon = toggle.querySelector("svg")!.getBoundingClientRect();
        return Math.min(
          icon.left - b.left,
          b.right - icon.right,
          icon.top - b.top,
          b.bottom - icon.bottom,
        );
      })(),
    };
  }, inputId);
  expect(layout.overlap).toBe(false);
  expect(layout.generationFirst).toBe(true);
  expect(layout.generationFits).toBe(true);
  expect(layout.inputWidth).toBeGreaterThan(60);
  expect(layout.toggleWidth).toBeGreaterThanOrEqual(44);
  expect(layout.toggleHeight).toBeGreaterThanOrEqual(44);
  expect(layout.iconInset).toBeGreaterThanOrEqual(8);
  await expect(page.locator(`[data-show="${inputId}"]`)).toHaveAccessibleName(
    "Show password",
  );
  await page.locator(`[data-show="${inputId}"]`).click();
  await expect(page.locator(`#${inputId}`)).toHaveAttribute("type", "text");
  await expect(page.locator(`[data-show="${inputId}"]`)).toHaveAccessibleName(
    "Hide password",
  );
  const revealedWidth = await page
    .locator(`#${inputId}`)
    .evaluate((node) => node.getBoundingClientRect().width);
  expect(revealedWidth).toBeCloseTo(layout.inputWidth, 1);
  await page.locator(`[data-show="${inputId}"]`).click();
}

for (const width of [1280, 600, 390, 320]) {
  test(`capacity and password controls remain ordered without overlap at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    const brand = await page.evaluate(async () => {
      const faces = await Promise.all([
        document.fonts.load("400 14px Roboto"),
        document.fonts.load("700 27.2px Roboto"),
      ]);
      await document.fonts.ready;
      const width = (selector: string) => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector(selector)!);
        return range.getBoundingClientRect().width;
      };
      return {
        name: width(".app-name"),
        tagline: width(".app-tagline"),
        fontsLoaded: faces.every(
          (matches) =>
            matches.length === 1 &&
            matches[0].family === "Roboto" &&
            matches[0].status === "loaded",
        ),
      };
    });
    expect(brand.fontsLoaded).toBe(true);
    // Platform font hinting changes glyph advances by a few CSS pixels.
    expect(Math.abs(brand.name - brand.tagline)).toBeLessThanOrEqual(4);
    await expect(page.locator("#add-message")).toHaveAccessibleName(
      "Add message",
    );
    await expect(page.locator("#remove-message")).toHaveCount(0);
    const actionSizes = await page
      .locator("#encrypt-button, #add-message")
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const style = getComputedStyle(button);
          return {
            height: button.getBoundingClientRect().height,
            fontSize: style.fontSize,
            padding: style.padding,
          };
        }),
      );
    expect(actionSizes[0]).toEqual(actionSizes[1]);
    if (width === 1280) {
      const add = page.locator("#add-message");
      const normalColor = await add.evaluate(
        (node) => getComputedStyle(node).backgroundColor,
      );
      await add.hover();
      const hoverColor = await add.evaluate(
        (node) => getComputedStyle(node).backgroundColor,
      );
      expect(hoverColor).not.toBe(normalColor);
    }
    await expectCapacityOrder(page);
    await expectPasswordControlsSeparated(page, "password");

    await expectSharedCapacity(page, 1, 0, "0% used");
    const texts = ["🌿é", "保持"]; // Six UTF-8 bytes each.
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
      await expectActionButtonsFit(page);
      const inputId = await page
        .locator("[data-message] [data-password]")
        .nth(index)
        .getAttribute("id");
      await expectPasswordControlsSeparated(page, inputId!);
    }
    await expect(page.locator("#add-message")).toBeHidden();
    await expect(page.locator("#encrypt-fields .remove-message")).toHaveCount(
      0,
    );
    const removalLayout = await page
      .locator("#encrypt-actions")
      .evaluate((row) => {
        const buttons = ["encrypt-button", "remove-message"].map((id) => {
          const button = row.querySelector(`#${id}`)!;
          const box = button.getBoundingClientRect();
          const style = getComputedStyle(button);
          const [red, green, blue] = style.backgroundColor
            .match(/[\d.]+/g)!
            .map(Number);
          return {
            size: {
              height: box.height,
              fontSize: style.fontSize,
              padding: style.padding,
            },
            width: box.width,
            top: box.top,
            brightness: 0.2126 * red + 0.7152 * green + 0.0722 * blue,
          };
        });
        const style = getComputedStyle(row);
        return {
          buttons,
          fitsOneRow:
            buttons[0].width + buttons[1].width + parseFloat(style.columnGap) <=
            row.clientWidth -
              parseFloat(style.paddingLeft) -
              parseFloat(style.paddingRight),
        };
      });
    const [create, remove] = removalLayout.buttons;
    expect(remove.size).toEqual(create.size);
    expect(remove.brightness).toBeGreaterThan(create.brightness);
    if (width >= 600) expect(removalLayout.fitsOneRow).toBe(true);
    if (removalLayout.fitsOneRow) expect(remove.top).toBeCloseTo(create.top, 1);
    const maximum = maximumTextBytes(2);
    await page
      .locator("[data-message] [data-text]")
      .last()
      .fill("x".repeat(maximum - 6));
    await expectSharedCapacity(page, 2, maximum, "Full");
    await page
      .locator("[data-message] [data-text]")
      .last()
      .fill("x".repeat(maximum - 5));
    await expectSharedCapacity(
      page,
      2,
      maximum + 1,
      "Over capacity — shorten your text",
    );
    await expectActionButtonsFit(page);

    // Removing and adding again must not leave stale values or reused ARIA IDs.
    await page.locator(".remove-message").last().click();
    await expectSharedCapacity(page, 1, 6, "Less than 1% used");
    await expect(page.locator("#remove-message")).toHaveCount(0);
    await expect(page.locator("#add-message")).toBeVisible();
    await expect(page.locator("#encryption-summary")).toHaveText(
      "Enter a message, choose a strong password, and print an encrypted QR code. Keep the password somewhere separate from the paper.",
    );
    await page.locator("#add-message").click();
    await expectSharedCapacity(page, 2, 6, "Less than 1% used");
    await page.getByLabel("Second message", { exact: true }).fill(texts[1]);
    await page
      .getByLabel("Second password", { exact: true })
      .fill("public second password");
    await expectSharedCapacity(page, 2, 12, "Less than 1% used");
    await page.locator(".remove-message").first().click();
    await expectSharedCapacity(page, 1, 6, "Less than 1% used");
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
      texts[0],
    );
    await page.reload();
    await expectSharedCapacity(page, 1, 0, "0% used");
    await expect(page.locator("#text")).toHaveValue("");
    await expectActionButtonsFit(page);

    await page.screenshot({
      path: testInfo.outputPath("encrypt.png"),
      fullPage: true,
    });

    // Public structural bytes exercise the pre-password UI without doing a KDF.
    const bytes = new Uint8Array(BACKUP_BYTES);
    bytes.set(PREAMBLE);
    await page.locator("#decrypt-tab").click();
    await expect(page.locator("#encoded")).toBeVisible();
    await expect(page.locator(".recovery-intro")).toBeVisible();
    const importLayout = await page.evaluate(() => {
      const text = document.getElementById("encoded")!.getBoundingClientRect();
      const scan = document.getElementById("scan")!.getBoundingClientRect();
      const photo = document
        .getElementById("choose-photo")!
        .getBoundingClientRect();
      return {
        textBottom: text.bottom,
        scanTop: scan.top,
        photoTop: photo.top,
        scanFont: getComputedStyle(document.getElementById("scan")!).fontSize,
        photoFont: getComputedStyle(document.getElementById("choose-photo")!)
          .fontSize,
        normalButtonFont: getComputedStyle(
          document.getElementById("encrypt-button")!,
        ).fontSize,
        noHorizontalOverflow:
          document.documentElement.scrollWidth <= innerWidth,
      };
    });
    expect(importLayout.scanTop).toBeGreaterThan(importLayout.textBottom);
    expect(importLayout.photoTop).toBe(importLayout.scanTop);
    expect(importLayout.scanFont).toBe(importLayout.normalButtonFont);
    expect(importLayout.photoFont).toBe(importLayout.normalButtonFont);
    expect(importLayout.noHorizontalOverflow).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("decrypt-import.png"),
      fullPage: true,
    });
    await page.locator("#encoded").fill(encodeTransport(bytes));

    await expect(page.locator("#loaded-backup-id")).toBeVisible();
    await expect(page.locator("#decrypt-form")).toBeVisible();
    await expect(page.locator(".recovery-intro")).toBeHidden();
    await expectPasswordControlsSeparated(page, "open-password");
    await page.screenshot({
      path: testInfo.outputPath("decrypt-password.png"),
      fullPage: true,
    });
    const recovery = await page.evaluate(() => {
      const id = document.getElementById("loaded-backup-id")!;
      const password = document.getElementById("open-password")!;
      const row = password.closest(".password-row")!;
      const button = document.getElementById("open-button")!;
      const change = document.getElementById("change-backup")!;
      return {
        idOutsideForm: id.closest("#decrypt-form") === null,
        idBottom: id.getBoundingClientRect().bottom,
        passwordTop: password.getBoundingClientRect().top,
        rowBottom: row.getBoundingClientRect().bottom,
        buttonTop: button.getBoundingClientRect().top,
        buttonHeight: button.getBoundingClientRect().height,
        changeTop: change.getBoundingClientRect().top,
        changeHeight: change.getBoundingClientRect().height,
        noHorizontalOverflow:
          document.documentElement.scrollWidth <= window.innerWidth,
      };
    });
    expect(recovery.idOutsideForm).toBe(true);
    expect(recovery.passwordTop).toBeGreaterThanOrEqual(recovery.idBottom);
    expect(recovery.buttonTop - recovery.rowBottom).toBeGreaterThanOrEqual(8);
    expect(recovery.noHorizontalOverflow).toBe(true);
    expect(recovery.changeHeight).toBe(recovery.buttonHeight);
    if (width >= 390) expect(recovery.changeTop).toBe(recovery.buttonTop);
    await expect(page.locator("#loaded-backup-id")).toHaveText(
      /^Backup [a-z]+(?: [a-z]+){3} loaded\.$/,
    );
    await expect(page.locator("#loaded-backup-id")).toHaveCSS(
      "font-style",
      "normal",
    );
    await expect(page.locator("#loaded-backup-id em")).toHaveCSS(
      "font-style",
      "italic",
    );
  });
}

test("PDF and text exports align on desktop and reflow on phones without clipping", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 440, height: 956 });
  await page.goto("/");
  await page.locator("#text").fill("Public mobile layout fixture");
  await page.locator("#password").fill("public mobile layout password");
  await page.locator("#encrypt-button").click();
  await expect(page.locator("#backup-result")).toBeVisible();
  await expect(page.locator("#save-text")).toHaveAccessibleName("Save as text");

  for (const enlarged of [false, true]) {
    if (enlarged)
      await page.evaluate(() => {
        for (const control of document.querySelectorAll<HTMLElement>(
          ".export-actions button, .paper-size-control select",
        ))
          control.style.fontSize = "36px";
        document.querySelector<HTMLElement>(
          ".paper-size-control",
        )!.style.fontSize = "26px";
      });
    for (const width of [1100, 440, 390, 320]) {
      await page.setViewportSize({ width, height: 956 });
      for (const value of ["A4", "Letter"]) {
        await page.locator("#paper-size").selectOption(value);
        const layout = await page.locator(".export-actions").evaluate((row) => {
          const elements = [
            row.querySelector("select")!,
            row.querySelector("#print")!,
            row.querySelector("#save-text")!,
          ];
          const boxes = elements.map((element) => {
            const box = element.getBoundingClientRect();
            return {
              top: box.top,
              right: box.right,
              bottom: box.bottom,
              left: box.left,
              height: box.height,
              unclipped: element.scrollWidth <= element.clientWidth,
            };
          });
          return {
            boxes,
            labelTop: row.querySelector("label")!.getBoundingClientRect().top,
            noOverflow: document.documentElement.scrollWidth <= innerWidth,
          };
        });
        expect(layout.noOverflow).toBe(true);
        expect(layout.labelTop).toBeLessThan(layout.boxes[0].top);
        for (const [index, box] of layout.boxes.entries()) {
          expect(box.unclipped).toBe(true);
          expect(box.height).toBeCloseTo(layout.boxes[0].height, 1);
          for (const other of layout.boxes.slice(index + 1))
            expect(
              Math.min(box.right, other.right) >
                Math.max(box.left, other.left) &&
                Math.min(box.bottom, other.bottom) >
                  Math.max(box.top, other.top),
            ).toBe(false);
          if (width >= 440 && !enlarged)
            expect(box.top).toBeCloseTo(layout.boxes[0].top, 1);
        }
      }
      await page.locator("#backup-result").screenshot({
        path: testInfo.outputPath(
          `exports-${width}-${enlarged ? "large" : "normal"}.png`,
        ),
      });
    }
  }
});

test("programmatic recovery heading focus is quiet without losing keyboard focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator("#decrypt-tab").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#decrypt-heading")).toBeFocused();
  await expect(page.locator("#decrypt-heading")).toHaveCSS(
    "outline-style",
    "none",
  );
  await page.keyboard.press("Tab");
  await expect(page.locator("#encoded")).toBeFocused();
  const focus = await page.locator("#encoded").evaluate((field) => {
    const style = getComputedStyle(field);
    return {
      visible: field.matches(":focus-visible"),
      style: style.outlineStyle,
      width: parseFloat(style.outlineWidth),
    };
  });
  expect(focus.visible).toBe(true);
  expect(focus.style).not.toBe("none");
  expect(focus.width).toBeGreaterThan(0);
});

test("the hosted footer stays centered and readable at phone widths", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  for (const width of [320, 360, 390, 430, 440, 480]) {
    await page.setViewportSize({ width, height: 956 });
    await expect(page.locator("#reader-status")).toHaveText(
      "You're using the website. For important backups, download the app and verify it to use it offline.",
      { useInnerText: true },
    );
    await expect(page.locator("#reader-status")).toHaveCSS(
      "text-align",
      "center",
    );
    const layout = await page.locator("#reader-status").evaluate((footer) => {
      const bounds = footer.getBoundingClientRect();
      const body = document.body.getBoundingClientRect();
      return {
        // A stable scrollbar gutter may reserve space outside the page body.
        centered:
          Math.abs(
            bounds.left + bounds.width / 2 - body.left - body.width / 2,
          ) < 1,
        noOverflow: document.documentElement.scrollWidth <= innerWidth,
      };
    });
    expect(layout).toEqual({ centered: true, noOverflow: true });
    await page.locator("#reader-status").screenshot({
      path: testInfo.outputPath(`footer-${width}.png`),
    });
  }
});

test("pagehide resets shared capacity for cleared fields before a cached page returns", async ({
  page,
}) => {
  await page.goto("/");
  for (let index = 0; index < 2; index++) {
    if (index) await page.locator("#add-message").click();
    await page
      .locator("[data-message] [data-text]")
      .nth(index)
      .fill("x".repeat(1400));
    await page
      .locator("[data-message] [data-password]")
      .nth(index)
      .fill(`public password ${index}`);
  }
  await expectSharedCapacity(
    page,
    2,
    2800,
    "Over capacity — shorten your text",
  );
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    ),
  );
  for (const input of await page
    .locator("[data-message] [data-text], [data-message] [data-password]")
    .all())
    await expect(input).toHaveValue("");
  await expectSharedCapacity(page, 2, 0, "0% used");
  await expect(page.locator("#add-message")).toBeHidden();
  await expect(page.locator("#message-limit")).toBeVisible();
  await page.locator(".remove-message").first().click();
  await expectSharedCapacity(page, 1, 0, "0% used");
  await expect(page.locator("#add-message")).toBeEnabled();
  await expect(page.locator("#message-limit")).toBeHidden();
});

test("touch controls suppress outlines and keyboard navigation restores visible focus", async ({
  browser,
}) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  try {
    await page.goto("http://127.0.0.1:4175/");
    for (const [open, close] of [
      ["about", "close-about"],
      ["donate", "close-donations"],
    ]) {
      await page.locator(`#${open}`).tap();
      await expect(page.locator(`#${close}`)).toBeFocused();
      await expect(page.locator(`#${close}`)).toHaveCSS(
        "outline-style",
        "none",
      );
      await page.keyboard.press("Tab");
      await expect(page.locator(":focus")).toHaveCSS("outline-style", "solid");
      await expect(page.locator(":focus")).toHaveCSS(
        "outline-color",
        "rgb(70, 70, 83)",
      );
      await page.locator(`#${close}`).tap();
      await expect(page.locator(`#${open}`)).toHaveCSS("outline-style", "none");
    }
    await page.locator("#add-message").tap();
    await expect(
      page.getByLabel("Second message", { exact: true }),
    ).toBeFocused();
    await expect(page.getByLabel("Second message", { exact: true })).toHaveCSS(
      "outline-style",
      "none",
    );
  } finally {
    await context.close();
  }
});
