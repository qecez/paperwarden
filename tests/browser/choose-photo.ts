import type { FileChooser, Page } from "@playwright/test";

export async function openPhotoChooser(page: Page): Promise<FileChooser> {
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#choose-photo").click();
  return chooser;
}

export async function choosePhoto(
  page: Page,
  files: Parameters<FileChooser["setFiles"]>[0],
) {
  await (await openPhotoChooser(page)).setFiles(files);
}
