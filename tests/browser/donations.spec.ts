import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import {
  BinaryBitmap,
  HybridBinarizer,
  QRCodeReader,
  RGBLuminanceSource,
} from "@zxing/library";

const addresses = {
  Bitcoin: "bc1qlr0gkrfpey0m5jvkfct6nsacawap3559m3q8lx",
  Monero:
    "8BDPbH2SwPoFhX8W3oTUvU3vRfvJ2eb19UTYMacszvRAFngdGwqc539gbSAvo7D2AU7ueRkviRAocbjpcnSJUbthRVTTUdp",
  EVMs: "0x9309e0b6f7e72712e6ce36d0a471fbb42a200cd9",
};
const schemes: Record<string, string> = {
  Bitcoin: "bitcoin",
  Monero: "monero",
  EVMs: "ethereum",
};

test("donation tabs copy the exact supplied addresses offline and keep downloads clean", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.copiedAddress = text;
        },
      },
    });
  });
  const requests: string[] = [];
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/");
  await context.setOffline(true);
  await expect(page.locator("header #donate")).toBeVisible();
  await expect(page.locator("header .project-link")).toHaveCount(0);
  await page.locator("#donate").click();
  await expect(page.locator("#donation-dialog")).toBeVisible();
  await expect(page.locator("#donation-heading")).toHaveText(
    "Support the project",
  );
  await expect(page.locator("#donation-address")).toHaveAttribute(
    "type",
    "text",
  );
  await expect(page.locator("#donation-address")).toHaveAttribute(
    "readonly",
    "",
  );
  const originalBox = await page.locator("#donation-dialog").boundingBox();
  for (const [name, address] of Object.entries(addresses)) {
    const tab = page.getByRole("tab", { name, exact: true });
    await tab.click();
    expect(
      await tab.evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return (
          range.getBoundingClientRect().height <=
          parseFloat(getComputedStyle(node).lineHeight)
        );
      }),
    ).toBe(true);
    await expect(
      page.getByLabel(
        name === "EVMs"
          ? "ETH and stables on Ethereum and other EVM chains."
          : `${name} address`,
        { exact: true },
      ),
    ).toHaveValue(address);
    await page.locator("#copy-donation").click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-copied-address",
      address,
    );
    await expect(page.locator("#donation-status")).toHaveText(
      "Address copied.",
    );
    expect(await page.locator("#donation-dialog").boundingBox()).toEqual(
      originalBox,
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page
    .getByRole("tab", { name: "EVMs", exact: true })
    .press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Bitcoin", exact: true }),
  ).toBeFocused();
  await expect(page.locator("#donation-address")).toHaveValue(
    addresses.Bitcoin,
  );
  await page.keyboard.press("Escape");
  await expect(page.locator("#donation-dialog")).toBeHidden();
  await expect(page.locator("#donate")).toBeFocused();
  const downloading = page.waitForEvent("download");
  await page.locator("#save-reader").click();
  const download = await downloading;
  expect(await readFile((await download.path())!)).toEqual(
    await readFile("dist/paperwarden.html"),
  );
  expect(requests).toEqual(["http://127.0.0.1:4175/"]);
});

test("an unavailable clipboard leaves the complete address selected for manual copying", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", { value: undefined }),
  );
  await page.goto("/");
  await page.locator("#donate").click();
  await page.locator("#copy-donation").click();
  await expect(page.locator("#donation-status")).toContainText(
    "Select and copy",
  );
  await expect(page.locator("#donation-address")).toBeFocused();
  expect(
    await page
      .locator("#donation-address")
      .evaluate((node: HTMLInputElement) =>
        node.value.slice(node.selectionStart ?? 0, node.selectionEnd ?? 0),
      ),
  ).toBe(addresses.Bitcoin);
});

test("the donation QRs share fixed geometry and decode to exact payment URIs offline", async ({
  page,
  context,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto("/");
  await context.setOffline(true);
  await page.locator("#donate").click();
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    let geometry: unknown;
    for (const [name, address] of Object.entries(addresses)) {
      await page.getByRole("tab", { name, exact: true }).click();
      const qr = page.locator("#donation-qr");
      await expect(qr).toHaveAttribute(
        "alt",
        `${name} donation address QR code`,
      );
      const uri = (await qr.getAttribute("src"))!;
      expect(uri).toMatch(/^data:image\/svg\+xml;base64,/);
      const svg = Buffer.from(uri.split(",")[1], "base64").toString("utf8");
      expect(svg).toContain('shape-rendering="geometricPrecision"');
      expect(svg).not.toMatch(/<script|<image|href=|url\(|onload=/i);
      await qr.evaluate((node: HTMLImageElement) => node.decode());
      const current = await page.evaluate(() =>
        [
          "donation-dialog",
          "donation-qr",
          "donation-address",
          "donation-status",
        ].map((id) =>
          document.getElementById(id)!.getBoundingClientRect().toJSON(),
        ),
      );
      if (geometry) expect(current).toEqual(geometry);
      else geometry = current;
      for (const scale of [1, 1.5, 2, 3]) {
        const raster = await qr.evaluate(async (node, scale) => {
          const image = node as HTMLImageElement;
          await image.decode();
          const side = Math.round(image.getBoundingClientRect().width * scale);
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = side;
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0, side, side);
          const pixels = context.getImageData(0, 0, side, side).data;
          return {
            side,
            png: canvas.toDataURL("image/png").split(",")[1],
            luminance: Array.from(
              { length: side * side },
              (_, i) =>
                (pixels[4 * i] + 2 * pixels[4 * i + 1] + pixels[4 * i + 2]) / 4,
            ),
          };
        }, scale);
        const bitmap = new BinaryBitmap(
          new HybridBinarizer(
            new RGBLuminanceSource(
              new Uint8ClampedArray(raster.luminance),
              raster.side,
              raster.side,
            ),
          ),
        );
        try {
          expect(new QRCodeReader().decode(bitmap).getText()).toBe(
            `${schemes[name]}:${address}`,
          );
        } catch (cause) {
          await test.info().attach(`${name}-${raster.side}px`, {
            body: Buffer.from(raster.png, "base64"),
            contentType: "image/png",
          });
          throw new Error(
            `${name} donation QR failed at ${raster.side} pixels`,
            {
              cause,
            },
          );
        }
      }
    }
  }
  expect(requests).toEqual(["http://127.0.0.1:4175/"]);
});
