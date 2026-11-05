import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import {
  ARCHIVE_BEGIN,
  ARCHIVE_END,
  decodeArchive,
} from "../../src/encoding/archive";
import reference from "../fixtures/reference.json" with { type: "json" };
import { choosePhoto } from "./choose-photo";
import { pdfSample, nodePreparer } from "./pdf-sample";

const PDFTOPPM = process.env.PDFTOPPM_PATH ?? "pdftoppm";
const PDFTOTEXT = process.env.PDFTOTEXT_PATH ?? "pdftotext";
const publicText = "PUBLIC PDF TEST: this text must remain encrypted. 🌿";
const publicPassword = "public fixture river morning copper";

async function save(page: Page, button: string, path: string) {
  const downloading = page.waitForEvent("download");
  await page.locator(button).click();
  const download = await downloading;
  await download.saveAs(path);
  return download.suggestedFilename();
}
function extract(path: string, layout = true): string {
  return execFileSync(PDFTOTEXT, [layout ? "-layout" : "-raw", path, "-"], {
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 1_000_000,
  });
}
function archive(text: string): string {
  // Preserve all intervening text: do not silently remove unexpected decorations.
  const begin = text.indexOf(ARCHIVE_BEGIN);
  const end = text.indexOf(ARCHIVE_END);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  return text.slice(begin, end + ARCHIVE_END.length);
}
async function recover(page: Page, password: string, text: string) {
  await page.locator("#open-password").fill(password);
  await page.locator("#open-button").click();
  await expect(page.locator("#recovered")).toBeVisible({ timeout: 60000 });
  expect(await page.locator("#recovered-text").textContent()).toBe(text);
}

test("PDF export uses an encrypted-only snapshot; editing invalidates every export", async ({
  page,
}, info) => {
  await page.goto("/");
  await page.locator("#text").fill(publicText);
  await page.locator("#password").fill(publicPassword);
  await page.locator("#encrypt-button").click();
  await expect(page.locator("#backup-result")).toBeVisible();
  const writtenPath = info.outputPath("written.txt");
  const name = await save(page, "#save-text", writtenPath);
  expect(name).toMatch(/^[a-z]+(?:-[a-z]+){3}\.txt$/);
  const written = await readFile(writtenPath, "utf8");
  const bytes = await decodeArchive(written);
  const expected = await (await nodePreparer()).preparePrint(bytes);
  expect(name).toBe(expected.words.replaceAll(" ", "-") + ".txt");
  await expect(page.locator("#backup-id")).toHaveCount(0);
  for (const size of ["A4", "Letter"] as const) {
    await page.locator("#paper-size").selectOption(size);
    const path = info.outputPath(`${size}.pdf`);
    expect(await save(page, "#print", path)).toBe(
      `${name.slice(0, -4)}-${size.toLowerCase()}.pdf`,
    );
    expect(await readFile(path)).toEqual(Buffer.from(expected.pdfs[size]));
    const text = extract(path);
    expect(Buffer.from(await decodeArchive(archive(text)))).toEqual(
      Buffer.from(bytes),
    );
    expect(text).not.toContain(publicText);
    expect(text).not.toContain(publicPassword);
  }
  await page.locator("#password").fill(publicPassword + " changed");
  await expect(page.locator("#backup-result")).toBeHidden();
  await expect(page.locator("#print")).toBeDisabled();
  await expect(page.locator("#save-text")).toBeDisabled();
  await expect(page.locator("#paper-size")).toBeDisabled();
  await expect(page.locator("#print-root")).toHaveCount(0);
  // Native printing cannot expose form secrets or invoke the obsolete print tree.
  await page.emulateMedia({ media: "print" });
  await expect(page.locator("#encrypt-view")).toBeHidden();
});

for (const size of ["A4", "Letter"] as const) {
  test(`PDF export ${size}: fixed fixture is identical across viewport, zoom, text settings and offline operation`, async ({
    browser,
    page,
  }, info) => {
    const fixtureBytes = new Uint8Array(Buffer.from(reference.hex, "hex"));
    const expected = await (await nodePreparer()).preparePrint(fixtureBytes);
    const samplePath = info.outputPath("public-sample.html");
    await writeFile(samplePath, await pdfSample());
    const context = await browser.newContext({ offline: true });
    const sample = await context.newPage();
    const network: string[] = [];
    context.on("request", (request) => {
      if (/^https?:/.test(request.url())) network.push(request.url());
    });
    let pdf = "";
    try {
      await sample.goto(pathToFileURL(samplePath).href);
      await expect(sample.locator("#status")).toHaveText("Ready");
      const settings = [
        { width: 1280, height: 800, zoom: "1", text: "100%" },
        { width: 390, height: 844, zoom: "1.5", text: "200%" },
        { width: 844, height: 390, zoom: "0.8", text: "300%" },
      ];
      for (let index = 0; index < settings.length; index++) {
        const setting = settings[index];
        await sample.setViewportSize(setting);
        await sample.evaluate(({ zoom, text }) => {
          document.documentElement.style.fontSize = text;
          document.body.style.zoom = zoom;
          document.documentElement.style.setProperty(
            "-webkit-text-size-adjust",
            text,
          );
        }, setting);
        pdf = info.outputPath(`fixed-${size}-${index}.pdf`);
        await save(sample, `#${size}`, pdf);
        expect(await readFile(pdf)).toEqual(Buffer.from(expected.pdfs[size]));
      }
      expect(network).toEqual([]);
    } finally {
      await context.close();
    }
    const text = extract(pdf);
    const pages = text.split("\f").filter((part) => part.trim());
    expect(pages).toHaveLength(4);
    const cover = pages[0].replace(/\s+/g, " ").trim();
    // The selectable identifier is read once, after the cover body; repeated
    // footer labels must never enter the copied archive or its continuation.
    expect(cover.endsWith(expected.words)).toBe(true);
    expect(pages[0]).not.toContain(`Backup ${expected.words}`);
    expect(extract(pdf, false).replace(/\s+/g, " ")).toContain(
      "This is an encrypted backup and can only be opened with a password.",
    );
    expect(cover).toContain("To recover this backup");
    for (const instruction of [
      "Saved app — recommended: open the saved copy of Paperwarden (paperwarden.html), then disconnect from the internet. Choose Decrypt, scan this QR or select a photo of it, and enter the password.",
      "Shortcut: scan the QR with your phone camera to open and read this backup on paperwarden.com. This is a convenience feature; for privacy, prefer the saved app offline.",
      "No password? It isn’t stored in this backup and can’t be reset. Check any instructions left for you, or ask whoever was entrusted with the password.",
      "No app? The last page explains how a developer can rebuild a compatible reader from scratch.",
      "Handwritten notes — don’t include the password or a hint. e.g. date printed, who this is for, where the saved app is.",
    ])
      expect(cover).toContain(instruction);
    expect(pages.slice(1).join(" ")).not.toContain(expected.words);
    expect(pages.slice(1).join(" ")).not.toContain("Handwritten notes");
    expect(pages[1]).toContain("Text copy");
    expect(text).not.toMatch(/\bwritten copy\b/i);
    expect(pages[3].replace(/\s+/g, " ")).toContain(
      "Technical recovery reference PWN-1 / self-contained recovery procedure",
    );
    expect(text).toContain("most significant bits first");
    expect(text).not.toMatch(/o[?@]ine|[XY]rst/);
    for (const message of reference.messages) {
      expect(text).not.toContain(message.password);
      expect(text).not.toContain(message.text);
    }
    const copied = archive(text);
    expect(Buffer.from(await decodeArchive(copied))).toEqual(
      Buffer.from(fixtureBytes),
    );
    expect(copied.match(/^\s*\d{3} /gm)).toHaveLength(115);
    // Safari-style inserted page decorations remain a hard validation failure.
    await expect(
      decodeArchive(
        copied.replace("057 ", "https://paperwarden.com 3/6\n057 "),
      ),
    ).rejects.toThrow();
    await page.goto("/");
    await page.locator("#decrypt-tab").click();
    for (const resolution of [2200, 1800]) {
      const png = info.outputPath(`qr-${size}-${resolution}`);
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
          png,
        ],
        { timeout: 30000 },
      );
      await choosePhoto(page, png + ".png");
      await expect(page.locator("#decrypt-form")).toBeVisible();
      await expect(page.locator("#loaded-backup-id")).toHaveText(
        `Backup ${expected.words} loaded.`,
      );
      await recover(
        page,
        reference.messages[1].password,
        reference.messages[1].text,
      );
      await page.locator("#load-another").click();
    }
    await page.locator("#encoded").fill(copied);
    await recover(
      page,
      reference.messages[0].password,
      reference.messages[0].text,
    );
  });
}

test("PDF export from the actual saved app works offline without network requests", async ({
  page,
  browser,
}, info) => {
  await page.goto("/");
  const app = info.outputPath("paperwarden.html");
  await save(page, "#save-reader", app);
  const context = await browser.newContext({
    offline: true,
    viewport: { width: 390, height: 844 },
  });
  const local = await context.newPage();
  const network: string[] = [];
  context.on("request", (request) => {
    if (/^https?:/.test(request.url())) network.push(request.url());
  });
  try {
    await local.goto(pathToFileURL(app).href);
    await local.locator("#encrypt-tab").click();
    await local.locator("#text").fill(publicText);
    await local.locator("#password").fill(publicPassword);
    await local.locator("#encrypt-button").click();
    await expect(local.locator("#backup-result")).toBeVisible();
    const writtenPath = info.outputPath("offline.txt");
    await save(local, "#save-text", writtenPath);
    const bytes = await decodeArchive(await readFile(writtenPath, "utf8"));
    const expected = await (await nodePreparer()).preparePrint(bytes);
    for (const size of ["A4", "Letter"] as const) {
      await local.locator("#paper-size").selectOption(size);
      const pdf = info.outputPath(`offline-${size}.pdf`);
      await save(local, "#print", pdf);
      expect(await readFile(pdf)).toEqual(Buffer.from(expected.pdfs[size]));
      expect(Buffer.from(await decodeArchive(archive(extract(pdf))))).toEqual(
        Buffer.from(bytes),
      );
    }
    expect(network).toEqual([]);
  } finally {
    await context.close();
  }
});
