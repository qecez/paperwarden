import { fingerprint } from "../crypto/primitives";
import { formatShortBackupId } from "../encoding/backup-id";
import { encodeArchive } from "../encoding/archive";
import { qrMatrix, QR_QUIET_ZONE } from "../encoding/qr";
import { RECOVERY_SECTIONS, RECOVERY_TITLE } from "./recovery-reference";
import {
  PdfDocument,
  PDF_SIZE,
  measure,
  type PdfPage,
  type PaperSize,
  type FontName,
  type PdfColor,
} from "./pdf";

const MM = 72 / 25.4;
const MARGIN = 12 * MM;
const QR_SIDE = 150 * MM;
const ARCHIVE_FIRST_PAGE_LINES = 56;

export interface PreparedBackup {
  readonly written: string;
  readonly words: string;
  readonly pdfs: Readonly<Record<PaperSize, Uint8Array>>;
}

function wrap(
  text: string,
  width: number,
  size: number,
  font: FontName,
  firstLineWidth = width,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (measure(word, size, font) > width)
      throw new Error("PDF word exceeds line width");
    const next = line ? line + " " + word : word;
    if (
      line &&
      measure(next, size, font) > (lines.length ? width : firstLineWidth)
    ) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function paragraph(
  page: PdfPage,
  text: string,
  y: number,
  width: number,
  size = 10.5,
  leading = 13.2,
  font: FontName = "regular",
  role: "P" | "H1" | "H2" | "H3" = "P",
) {
  const lines = wrap(text, width, size, font);
  page.text(lines, { x: MARGIN, y, size, leading, font, role });
  return y + lines.length * leading;
}

function labeledParagraph(
  page: PdfPage,
  label: string,
  text: string,
  y: number,
  width: number,
): number {
  const size = 10.5;
  const leading = 14.5;
  const prefix = label + " ";
  const prefixWidth = measure(prefix, size, "bold");
  const lines = text
    .split("\n")
    .flatMap((part, index) =>
      wrap(
        part,
        width,
        size,
        "regular",
        width - (index === 0 ? prefixWidth : 0),
      ),
    );
  page.textRuns(
    [
      {
        text: prefix,
        options: { x: MARGIN, y, size, leading, font: "bold" },
      },
      ...lines.map((line, index) => ({
        text: line + (index < lines.length - 1 ? " " : ""),
        options: {
          x: MARGIN + (index === 0 ? prefixWidth : 0),
          y: y + index * leading,
          size,
          leading,
        },
      })),
    ],
    "P",
  );
  return y + lines.length * leading;
}

// The website icon's geometry, with flat print colors in place of gradients.
// These fixed paths need no SVG parser or additional PDF resources.
function brand(page: PdfPage): void {
  const size = 22;
  const iconSize = 40;
  const paperWidth = measure("paper", size, "bold");
  const textWidth = paperWidth + measure("warden", size);
  const scale = iconSize / 256;
  const path = (
    points: readonly (number | string)[],
    fill: PdfColor,
    lock = false,
  ) => {
    let axis = 0;
    const mapped = points
      .map((part) => {
        if (typeof part === "string") {
          axis = 0;
          return part;
        }
        const vertical = axis++ % 2;
        // SVG: translate(129 130.5) scale(.9) translate(-129 -155).
        const coordinate = lock ? part * 0.9 + (vertical ? -9 : 12.9) : part;
        return String(MARGIN + coordinate * scale);
      })
      .join(" ");
    page.path(mapped, { fill });
  };
  path(
    [
      65,
      16,
      "m",
      155,
      16,
      "l",
      230,
      89,
      "l",
      230,
      202,
      "l",
      230,
      226,
      211,
      245,
      187,
      245,
      "c",
      68,
      245,
      "l",
      44,
      245,
      25,
      226,
      25,
      202,
      "c",
      25,
      56,
      "l",
      25,
      34,
      43,
      16,
      65,
      16,
      "c",
      "h",
    ],
    [237 / 255, 236 / 255, 233 / 255],
  );
  path(
    [
      155,
      16,
      "m",
      230,
      89,
      "l",
      177,
      89,
      "l",
      165,
      89,
      155,
      79,
      155,
      67,
      "c",
      "h",
    ],
    [182 / 255, 181 / 255, 178 / 255],
  );
  const ink = [48 / 255, 55 / 255, 62 / 255] as const;
  path(
    [
      99,
      148,
      "m",
      99,
      133,
      "l",
      99,
      115,
      112,
      101,
      129,
      101,
      "c",
      146,
      101,
      159,
      115,
      159,
      133,
      "c",
      159,
      148,
      "l",
      146,
      148,
      "l",
      146,
      133,
      "l",
      146,
      123,
      139,
      115,
      129,
      115,
      "c",
      119,
      115,
      112,
      123,
      112,
      133,
      "c",
      112,
      148,
      "l",
      "h",
    ],
    ink,
    true,
  );
  // Rounded rectangle from the SVG: x=89, y=142, w=80, h=67, r=13.
  const curve = 13 * 0.5522847498307936;
  path(
    [
      102,
      142,
      "m",
      156,
      142,
      "l",
      156 + curve,
      142,
      169,
      155 - curve,
      169,
      155,
      "c",
      169,
      196,
      "l",
      169,
      196 + curve,
      156 + curve,
      209,
      156,
      209,
      "c",
      102,
      209,
      "l",
      102 - curve,
      209,
      89,
      196 + curve,
      89,
      196,
      "c",
      89,
      155,
      "l",
      89,
      155 - curve,
      102 - curve,
      142,
      102,
      142,
      "c",
      "h",
    ],
    ink,
    true,
  );
  const textX = MARGIN + iconSize + 8;
  page.textRuns(
    [
      {
        text: "paper",
        options: { x: textX, y: MARGIN + 2, size, leading: 26, font: "bold" },
      },
      {
        text: "warden",
        options: { x: textX + paperWidth, y: MARGIN + 2, size, leading: 26 },
      },
    ],
    "H1",
  );
  const tagline = "Encrypted Paper Backups";
  page.text([tagline], {
    x: textX,
    y: MARGIN + 27,
    size: textWidth / measure(tagline, 1),
    leading: 14,
    color: 0.3,
    role: "P",
  });
}

function buildPdf(
  encrypted: Uint8Array,
  written: string,
  words: string,
  paper: PaperSize,
): Uint8Array {
  const { width, height } = PDF_SIZE[paper];
  const contentWidth = width - MARGIN * 2;
  const document = new PdfDocument(paper);
  const cover = document.addPage();
  brand(cover);
  const noticeLines = [
    "This is an encrypted backup and can",
    "only be opened with a password.",
  ];
  const noticeWidth =
    Math.max(...noticeLines.map((line) => measure(line, 10))) + 12;
  const noticeRight = width - MARGIN;
  cover.rect(noticeRight - noticeWidth, MARGIN + 8, noticeWidth, 28, {
    stroke: 0.55,
    lineWidth: 0.6,
    dash: [1, 2],
  });
  cover.textRuns(
    noticeLines.map((line, index) => ({
      text: line + (index < noticeLines.length - 1 ? " " : ""),
      options: {
        x: noticeRight - (noticeWidth + measure(line, 10)) / 2,
        y: MARGIN + 9.5 + index * 12,
        size: 10,
        leading: 12,
        color: 0.2,
      },
    })),
    "P",
  );
  const qrTop = MARGIN + 56;
  const qrLeft = (width - QR_SIDE) / 2;
  const { modules } = qrMatrix(encrypted);
  const unit = QR_SIDE / (modules.size + QR_QUIET_ZONE * 2);
  cover.figure(
    "Encrypted Paperwarden backup QR code. The same encrypted bytes are in the text copy on pages 2 and 3.",
    () => {
      cover.rect(qrLeft, qrTop, QR_SIDE, QR_SIDE, { fill: 1 });
      const runs: [number, number, number, number][] = [];
      for (let row = 0; row < modules.size; row++) {
        let column = 0;
        while (column < modules.size) {
          if (!modules.get(row, column)) {
            column++;
            continue;
          }
          const start = column++;
          while (column < modules.size && modules.get(row, column)) column++;
          runs.push([
            qrLeft + (start + QR_QUIET_ZONE) * unit,
            qrTop + (row + QR_QUIET_ZONE) * unit,
            (column - start) * unit,
            unit,
          ]);
        }
      }
      cover.rectangles(runs, { fill: 0 });
    },
  );
  let y = qrTop + QR_SIDE + 12;
  y =
    paragraph(
      cover,
      "To recover this backup",
      y,
      contentWidth,
      12,
      15,
      "bold",
      "H2",
    ) + 7;
  for (const [label, text] of [
    [
      "Saved app — recommended:",
      "open the saved copy of Paperwarden (paperwarden.html), then disconnect from the internet. Choose Decrypt, scan this QR or select a photo of it, and enter the password.",
    ],
    [
      "Shortcut:",
      "scan the QR with your phone camera to open and read this backup on paperwarden.com.\nThis is a convenience feature; for privacy, prefer the saved app offline.",
    ],
    [
      "No password?",
      "It isn’t stored in this backup and can’t be reset.\nCheck any instructions left for you, or ask whoever was entrusted with the password.",
    ],
    [
      "No app?",
      "The last page explains how a developer can rebuild a compatible reader from scratch.",
    ],
  ])
    y = labeledParagraph(cover, label, text, y, contentWidth) + 8;
  y += 3;
  const notesBottom = height - MARGIN - 16;
  if (notesBottom - y < 46)
    throw new Error("Insufficient space for handwritten notes");
  cover.rect(MARGIN, y, contentWidth, notesBottom - y, {
    stroke: 0.55,
    lineWidth: 0.6,
    dash: [1, 2],
  });
  const notesLines = [
    {
      text: "Handwritten notes — don’t include the password or a hint.",
      italic: false,
    },
    {
      text: "e.g. date printed, who this is for, where the saved app is.",
      italic: true,
    },
  ];
  cover.textRuns(
    notesLines.map(({ text, italic }, index) => ({
      text: text + (index < notesLines.length - 1 ? " " : ""),
      options: {
        x: MARGIN + 8,
        y: y + 6 + index * 12,
        size: 9.5,
        leading: 12,
        italic,
        color: 0.35,
      },
    })),
    "P",
  );

  const archive = written.split("\n");
  if (archive.length !== 119)
    throw new Error("Unexpected text-copy line count");
  const first = document.addPage();
  let archiveY =
    paragraph(first, "Text copy", MARGIN, contentWidth, 16, 20, "bold", "H1") +
    6;
  archiveY =
    paragraph(
      first,
      "If the QR code cannot be read, paste the entire block below into Decrypt, including the BEGIN and END markers.",
      archiveY,
      contentWidth,
    ) + 5;
  archiveY =
    paragraph(
      first,
      "Keep all numbered lines and the SHA256 fingerprint.",
      archiveY,
      contentWidth,
    ) + 10;
  first.text(archive.slice(0, ARCHIVE_FIRST_PAGE_LINES), {
    x: MARGIN,
    y: archiveY,
    size: 10,
    leading: 10.9,
    font: "mono",
    role: "P",
  });
  const second = document.addPage();
  // No selectable header or footer may interrupt the BEGIN-to-END block.
  second.text(archive.slice(ARCHIVE_FIRST_PAGE_LINES), {
    x: MARGIN,
    y: MARGIN,
    size: 10,
    leading: 10.9,
    font: "mono",
    role: "P",
  });

  const reference = document.addPage();
  y =
    paragraph(
      reference,
      RECOVERY_TITLE,
      MARGIN,
      contentWidth,
      14,
      17,
      "bold",
      "H1",
    ) + 5;
  y =
    paragraph(
      reference,
      "PWN-1 / self-contained recovery procedure",
      y,
      contentWidth,
      10.5,
      12.5,
    ) + 4;
  for (const [heading, paragraphs] of RECOVERY_SECTIONS) {
    y =
      paragraph(reference, heading, y, contentWidth, 11, 13, "bold", "H2") + 2;
    for (const text of paragraphs)
      y = paragraph(reference, text, y, contentWidth, 10.5, 12.5) + 2;
    y += 3;
  }
  if (y > height - MARGIN - 12)
    throw new Error("Recovery reference exceeds its page");
  const footerY = height - MARGIN + 5;
  for (const [index, page] of [cover, first, second, reference].entries()) {
    // Read the identifier once, after the cover body. Repeated labels are artifacts.
    if (index === 0) {
      page.text([words], {
        x: MARGIN,
        y: footerY,
        size: 9,
        leading: 11,
        color: 0.4,
        italic: true,
        role: "P",
      });
    } else page.backupLabel(words, MARGIN, footerY, 9);
    const text = "Page " + (index + 1) + "/4";
    page.footer(text, width - MARGIN - measure(text, 9), footerY, 9);
  }
  return document.save();
}

/** Freeze only encrypted data; no DOM, viewport, system fonts, or native print engine. */
export async function preparePrint(
  bytes: Uint8Array,
  options: { signal?: AbortSignal } = {},
): Promise<PreparedBackup> {
  options.signal?.throwIfAborted();
  const encrypted = bytes.slice();
  const [digest, written] = await Promise.all([
    fingerprint(encrypted),
    encodeArchive(encrypted),
  ]);
  options.signal?.throwIfAborted();
  const words = formatShortBackupId(digest);
  const A4 = buildPdf(encrypted, written, words, "A4");
  const Letter = buildPdf(encrypted, written, words, "Letter");
  options.signal?.throwIfAborted();
  return { written, words, pdfs: { A4, Letter } };
}
