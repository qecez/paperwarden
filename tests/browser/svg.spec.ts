import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

// Assert the documented input limit independently of the production decoder.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const messages = [
  {
    text: "PUBLIC SVG FIXTURE — saved website image 🌿\nKeep these spaces  ",
    password: "public SVG river copper morning",
  },
  {
    text: "PUBLIC SVG FIXTURE — another password\n保持 Café",
    password: "public SVG moon forest evening",
  },
];

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

async function generate(page: Page, twoMessages = false) {
  await page.goto("/");
  await page.locator("#text").fill(messages[0].text);
  await page.locator("#password").fill(messages[0].password);
  if (twoMessages) {
    await page.locator("#add-message").click();
    await page
      .locator(".additional-message [data-text]")
      .fill(messages[1].text);
    await page
      .locator(".additional-message [data-password]")
      .fill(messages[1].password);
  }
  await page.locator("#encrypt-button").click();
  await expect(page.locator("#backup-result")).toBeVisible();
  await expect(page.locator("#print")).toBeEnabled();
}

test("the actual saved website SVG opens both messages offline, including an empty MIME type", async ({
  page,
}) => {
  await generate(page, true);

  // Save the actual displayed image bytes, as Save Image As does; do not rebuild
  // the QR or turn it into a PNG, which would bypass the SVG import regression.
  const downloadEvent = page.waitForEvent("download");
  await page.locator("#qr").evaluate((node) => {
    const anchor = document.createElement("a");
    anchor.href = (node as HTMLImageElement).src;
    anchor.download = "paperwarden-backup.svg";
    anchor.click();
  });
  const download = await downloadEvent;
  const saved = await readFile((await download.path())!);
  expect(saved.toString("utf8")).toContain('viewBox="0 0 185 185"');
  expect(saved.toString("utf8")).not.toContain(messages[0].text);
  expect(saved.toString("utf8")).not.toContain(messages[1].text);

  await page.context().setOffline(true);
  await page.locator("#decrypt-tab").click();
  await page.locator("#photo").setInputFiles({
    name: "paperwarden-backup.svg",
    mimeType: "image/svg+xml",
    buffer: saved,
  });
  await expect(page.locator("#open-password")).toBeFocused();
  await expect(page.locator("#decrypt-error")).toBeHidden();
  for (const message of messages) {
    await recover(page, message);
    await page.locator("#close-text").click();
  }

  // Some systems provide an empty File.type. Verify the extension fallback
  // using an actual empty-MIME File rather than a guessed upload content type.
  const mime = await page.locator("#photo").evaluate((node, svg) => {
    const file = new File([svg], "saved-backup.SVG", { type: "" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    (node as HTMLInputElement).files = transfer.files;
    node.dispatchEvent(new Event("change", { bubbles: true }));
    return file.type;
  }, saved.toString("utf8"));
  expect(mime).toBe("");
  await expect(page.locator("#choose-photo")).toBeEnabled();
  await expect(page.locator("#decrypt-error")).toBeHidden();
  await expect(page.locator("#load-message")).toContainText("Backup loaded");
  await recover(page, messages[1]);
});

test("SVG imports stay passive: scripts, event handlers and external resources do not run", async ({
  page,
}) => {
  const requests: string[] = [];
  const dialogs: string[] = [];
  await page.route("https://svg-import.invalid/**", async (route) => {
    requests.push(route.request().url());
    await route.abort();
  });
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await generate(page);
  const imageSource = await page.locator("#qr").getAttribute("src");
  expect(imageSource).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
  const saved = decodeURIComponent(
    imageSource!.slice(imageSource!.indexOf(",") + 1),
  );
  await page.locator("#decrypt-tab").click();
  const active = saved
    .replace(
      "<svg ",
      "<svg onload=\"document.documentElement.dataset.svgExecuted=1;alert('SVG event executed')\" ",
    )
    .replace(
      "</svg>",
      `
      <g id="svg-import-marker"/>
      <script>document.documentElement.dataset.svgExecuted=1;alert('SVG script executed');fetch('https://svg-import.invalid/script')</script>
      <style>@import url("https://svg-import.invalid/style.css");</style>
      <image href="https://svg-import.invalid/image.png" width="1" height="1"/>
      <use href="https://svg-import.invalid/external.svg#shape"/>
    </svg>`,
    );
  await page.locator("#photo").setInputFiles({
    name: "public-active-content.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(active),
  });
  await expect(page.locator("#choose-photo")).toBeEnabled();
  await expect(page.locator("#decrypt-error")).toBeHidden();
  await expect(page.locator("#decrypt-form")).toBeVisible();
  await expect(page.locator("#load-message")).toContainText("Backup loaded");
  expect(
    await page.locator("html").getAttribute("data-svg-executed"),
  ).toBeNull();
  await expect(page.locator("#svg-import-marker")).toHaveCount(0);
  expect(dialogs).toEqual([]);
  expect(requests).toEqual([]);
});

test("malformed SVGs, oversized images and unsupported MIME claims are rejected", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#decrypt-tab").click();
  const candidates = [
    {
      name: "malformed.svg",
      mimeType: "image/svg+xml",
      text: '<svg xmlns="http://www.w3.org/2000/svg"><path',
    },
    {
      name: "too-many-pixels.svg",
      mimeType: "image/svg+xml",
      text: '<svg xmlns="http://www.w3.org/2000/svg" width="8000" height="6000"><rect width="100%" height="100%"/></svg>',
    },
    {
      name: "wrong-type.svg",
      mimeType: "text/html",
      text: '<html><script>alert("not an image")</script></html>',
    },
    {
      name: "not-an-svg.svg",
      mimeType: "image/svg+xml",
      text: "PUBLIC NON-IMAGE FIXTURE",
    },
  ];
  for (const file of candidates) {
    await page.locator("#photo").setInputFiles({
      name: file.name,
      mimeType: file.mimeType,
      buffer: Buffer.from(file.text),
    });
    await expect(page.locator("#choose-photo")).toBeEnabled();
    await expect(page.locator("#decrypt-error")).toBeVisible();
    await expect(page.locator("#decrypt-form")).toBeHidden();
    await expect(page.locator("#load-message")).toBeEmpty();
  }
  // Reject the byte bound before asking the browser to decode any SVG content.
  await page.locator("#photo").evaluate((node, limit) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array(limit + 1)], "too-large.svg", {
        type: "image/svg+xml",
      }),
    );
    (node as HTMLInputElement).files = transfer.files;
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }, MAX_IMAGE_BYTES);
  await expect(page.locator("#choose-photo")).toBeEnabled();
  await expect(page.locator("#decrypt-error")).toBeVisible();
  await expect(page.locator("#decrypt-form")).toBeHidden();
});
