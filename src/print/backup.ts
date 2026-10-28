import { fingerprint } from "../crypto/primitives";
import { formatBackupId } from "../encoding/backup-id";
import { encodeArchive } from "../encoding/archive";
import { qrSvg } from "../encoding/qr";

function paragraph(text: string, className = ""): HTMLParagraphElement {
  const element = document.createElement("p");
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

/** Prepare an immutable encrypted-only print snapshot and atomically replace the last one. */
export async function preparePrint(
  bytes: Uint8Array,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const { signal } = options;
  signal?.throwIfAborted();
  const encrypted = bytes.slice();
  const root = document.getElementById("print-root");
  if (!root) throw new Error("Missing print surface");
  const [digest, archive] = await Promise.all([
    fingerprint(encrypted),
    encodeArchive(encrypted),
  ]);
  signal?.throwIfAborted();
  const fragment = document.createDocumentFragment();
  const sheet = document.createElement("section");
  sheet.className = "sheet";
  const title = document.createElement("h1");
  title.textContent = "PAPERWARDEN";
  const image = new Image();
  image.className = "qr";
  image.alt = "Encrypted backup QR code";
  image.src =
    "data:image/svg+xml;charset=utf-8," + encodeURIComponent(qrSvg(encrypted));
  sheet.append(
    title,
    paragraph("Encrypted paper backup"),
    image,
    paragraph(`Backup ID: ${formatBackupId(digest)}`, "backup-id"),
    paragraph(
      "Scan this QR with your phone camera to open paperwarden.com, then enter your password. For offline recovery, open paperwarden.html, choose Decrypt, and scan this QR or choose an image.",
    ),
    paragraph(
      "Store this paper and a downloaded copy of the app. Keep your password separately; it cannot be reset.",
    ),
    paragraph(
      "Print at actual size (100%) on A4 or US Letter, preserving the full white border. Test the printed QR before storing it.",
    ),
  );
  fragment.append(sheet);

  const written = document.createElement("section");
  written.className = "archive-sheet";
  const heading = document.createElement("h2");
  heading.textContent = "Archival written copy";
  written.append(
    heading,
    paragraph(
      "This is another representation of the same encrypted backup. If the QR cannot be read, choose “Paste backup” and enter all the lines below.",
    ),
    paragraph(
      "Keep every numbered line and the SHA256 fingerprint. The app checks copying errors before asking for your password.",
    ),
  );
  for (const line of archive.split("\n")) {
    written.append(
      paragraph(
        line,
        line.startsWith("SHA256") ? "full-fingerprint" : "archive-line",
      ),
    );
  }
  written.append(
    paragraph(
      "End of written copy. Recovery requires a PWN-1 reader and your password. Save the format specification with your reader for long-term reference.",
    ),
  );
  fragment.append(written);
  await image.decode();
  signal?.throwIfAborted();
  root.replaceChildren(fragment);
}
