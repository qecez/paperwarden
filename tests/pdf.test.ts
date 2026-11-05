import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PdfDocument, measure, pdfDimensions } from "../src/print/pdf";
import regular from "../src/print/fonts/regular.json";
import bold from "../src/print/fonts/bold.json";
import mono from "../src/print/fonts/mono.json";

function sample(size: "A4" | "Letter" = "A4") {
  const document = new PdfDocument(size);
  for (let index = 0; index < 4; index++) {
    const page = document.addPage();
    page.text(
      [
        "offline first efficient office affine",
        "ASCII () \\ << /JavaScript >> % and — ‘quotes’",
      ],
      {
        x: 34,
        y: 34,
        size: 10,
        leading: 13,
        role: "P",
      },
    );
    page.figure("Public vector fixture", () =>
      page.rect(34, 90, 20, 20, { fill: 0 }),
    );
    const label = `Page ${index + 1}/4`;
    page.footer(
      label,
      (page.width - measure(label, 8)) / 2,
      page.height - 24,
      8,
    );
  }
  return document.save();
}

function syntax(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

describe("fixed PDF writer", () => {
  it("emits deterministic bytes and explicit A4/Letter dimensions", () => {
    expect(sample()).toEqual(sample());
    expect(sample("Letter")).toEqual(sample("Letter"));
    expect(sample()).not.toEqual(sample("Letter"));
    expect(pdfDimensions("A4").width).toBeCloseTo((210 / 25.4) * 72, 8);
    expect(pdfDimensions("Letter")).toEqual({ width: 612, height: 792 });
    expect(() => pdfDimensions("toString" as "A4")).toThrow();
    expect(syntax(sample("Letter"))).toContain("/MediaBox [0 0 612 792]");
  });

  it("has exact binary stream lengths and cross-reference byte offsets", () => {
    const bytes = sample();
    const pdf = syntax(bytes);
    const xrefOffset = Number(/startxref\n(\d+)\n%%EOF/.exec(pdf)![1]);
    expect(pdf.slice(xrefOffset, xrefOffset + 5)).toBe("xref\n");
    const entries = /^xref\n0 (\d+)\n([\s\S]+?)trailer\n/.exec(
      pdf.slice(xrefOffset),
    )!;
    const rows = entries[2].trimEnd().split("\n");
    expect(rows).toHaveLength(Number(entries[1]));
    for (let id = 1; id < rows.length; id++) {
      const offset = Number(rows[id].slice(0, 10));
      expect(pdf.slice(offset)).toMatch(new RegExp(`^${id} 0 obj\\n`));
    }
    // This checks byte lengths, including TrueType binary streams containing non-ASCII.
    for (const match of pdf.matchAll(/\/Length (\d+) >>\nstream\n/g)) {
      const start = match.index! + match[0].length;
      const end = start + Number(match[1]);
      expect(pdf.slice(end, end + 10)).toBe("\nendstream");
    }
    expect(pdf.match(/\/Type \/Page\b/g)).toHaveLength(4);
  });

  it("includes structure, explicit Unicode mappings, and no active PDF features", () => {
    const pdf = syntax(sample());
    expect(pdf).toContain("/MarkInfo << /Marked true >>");
    expect(pdf).toContain("/Type /StructTreeRoot");
    expect(pdf.match(/\/StructParents \d+/g)).toHaveLength(4);
    expect(pdf.match(/\/S \/P /g)).toHaveLength(4);
    expect(pdf.match(/\/S \/Figure /g)).toHaveLength(4);
    expect(pdf.match(/\/ToUnicode \d+ 0 R/g)).toHaveLength(3);
    expect(pdf.match(/\/CIDToGIDMap \d+ 0 R/g)).toHaveLength(3);
    expect(pdf).toContain("/PrintScaling /None");
    expect(pdf).not.toMatch(
      /\/JavaScript\b|\/JS\b|\/OpenAction\b|\/AA\b|\/AcroForm\b|\/EmbeddedFiles\b|\/URI\b/,
    );
    expect(pdf).not.toContain("Page 1/4");
    expect(pdf).not.toMatch(/\/CreationDate\b|\/ModDate\b/);
  });

  it("rejects unsupported characters, path injection, invalid coordinates, and wrong page counts", () => {
    const document = new PdfDocument("Letter");
    const page = document.addPage();
    expect(() =>
      page.text(["🌱"], { x: 30, y: 30, size: 10, leading: 12, role: "P" }),
    ).toThrow(/character/);
    expect(() =>
      page.text(["x"], { x: 610, y: 30, size: 10, leading: 12, role: "P" }),
    ).toThrow(/bounds/);
    expect(() => page.path("10 10 m /JavaScript", { fill: 0 })).toThrow(/path/);
    expect(() => page.path("10 10 m 30 l", { fill: 0 })).toThrow(/path/);
    expect(() => page.rect(NaN, 0, 10, 10, { fill: 0 })).toThrow(/bounds/);
    expect(() => page.rect(0, 0, 10, 10, { fill: 2 })).toThrow(/color/);
    expect(() => document.save()).toThrow(/four pages/);
    document.addPage();
    document.addPage();
    document.addPage();
    expect(() => document.addPage()).toThrow(/four pages/);
  });

  it("embeds reviewed font bytes and one distinct mapping per printable character", () => {
    for (const font of [regular, bold, mono]) {
      const data = Buffer.from(font.data, "base64");
      expect(createHash("sha256").update(data).digest("hex")).toBe(
        font.fontSha256,
      );
      const characters = Object.entries(font.characters);
      expect(characters).toHaveLength(103);
      expect(new Set(characters.map(([, glyph]) => glyph[0])).size).toBe(103);
      for (const [character, [cid, gid, width]] of characters) {
        expect(character.length).toBe(1);
        expect(cid).toBeGreaterThan(0);
        expect(cid).toBeLessThanOrEqual(103);
        expect(gid).toBeGreaterThan(0);
        expect(width).toBeGreaterThan(0);
      }
    }
  });

  it("refuses partially drawn or finalized documents", () => {
    const broken = new PdfDocument("A4");
    const page = broken.addPage();
    for (let index = 1; index < 4; index++) broken.addPage();
    expect(() =>
      page.figure("Broken figure", () => {
        page.rect(20, 20, 30, 30, { fill: 0 });
        throw new Error("drawing interrupted");
      }),
    ).toThrow(/interrupted/);
    expect(() => broken.save()).toThrow(/drawing failed/);

    const finalized = new PdfDocument("A4");
    const first = finalized.addPage();
    for (let index = 1; index < 4; index++) finalized.addPage();
    finalized.save();
    expect(() => finalized.save()).toThrow(/finalized/);
    expect(() => first.rect(0, 0, 20, 20, { fill: 0 })).toThrow(/finalized/);
    expect(() => measure("x", 10, "toString" as "regular")).toThrow(/font/);
  });

  it("batches QR rectangles without weakening geometry validation", () => {
    const document = new PdfDocument("A4");
    const page = document.addPage();
    const rectangles = [
      [34, 34, 5, 2],
      [41, 34, 2, 2],
    ] as const;
    page.figure("QR modules", () => page.rectangles(rectangles, { fill: 0 }));
    for (let index = 1; index < 4; index++) document.addPage();
    const pdf = syntax(document.save());
    expect(pdf).toContain("34 34 5 2 re\n41 34 2 2 re\nf");
    const invalid = new PdfDocument("A4").addPage();
    expect(() => invalid.rectangles([], { fill: 0 })).toThrow(/Empty/);
    expect(() => invalid.rectangles([[34, 34, 1000, 2]], { fill: 0 })).toThrow(
      /bounds/,
    );
  });

  it("keeps a styled wordmark in one logical heading before the following paragraph", () => {
    const document = new PdfDocument("A4");
    const page = document.addPage();
    page.textRuns(
      [
        {
          text: "paper",
          options: { x: 34, y: 34, size: 22, leading: 26, font: "bold" },
        },
        {
          text: "warden",
          options: {
            x: 34 + measure("paper", 22, "bold"),
            y: 34,
            size: 22,
            leading: 26,
          },
        },
      ],
      "H1",
    );
    page.text(["Encrypted paper backup"], {
      x: 34,
      y: 70,
      size: 10,
      leading: 12,
      role: "P",
    });
    for (let index = 1; index < 4; index++) document.addPage();
    const pdf = syntax(document.save());
    expect(pdf.match(/\/S \/H1 /g)).toHaveLength(1);
    expect(pdf.match(/\/H1 << /g)).toHaveLength(1);
    const heading = /\/H1 << \/MCID 0[\s\S]+?\nEMC/.exec(pdf)![0];
    expect(heading).toContain(
      "/ActualText <FEFF0070006100700065007200770061007200640065006E>",
    );
    expect(heading.indexOf("/FB 22 Tf")).toBeLessThan(
      heading.indexOf("/FR 22 Tf"),
    );
    expect(pdf.indexOf(heading)).toBeLessThan(pdf.indexOf("/P << /MCID 1"));
    const roles = [...pdf.matchAll(/\/Type \/StructElem \/S \/(H1|P) /g)].map(
      (match) => match[1],
    );
    expect(roles).toEqual(["H1", "P"]);

    const invalid = new PdfDocument("A4").addPage();
    expect(() => invalid.textRuns([], "H1")).toThrow(/runs/);
    expect(() =>
      invalid.textRuns(
        [{ text: "x", options: { x: 590, y: 30, size: 22, leading: 26 } }],
        "H1",
      ),
    ).toThrow(/bounds/);
  });

  it("keeps repeated backup labels and pagination out of selectable archive text", () => {
    const document = new PdfDocument("Letter");
    for (let index = 0; index < 4; index++) {
      const page = document.addPage();
      const label = `Page ${index + 1}/4`;
      page.backupLabel("cheese sweet tobacco anchor", 34, 765, 9);
      page.footer(label, page.width - 34 - measure(label, 9), 765, 9);
    }
    const pdf = syntax(document.save());
    const artifacts = [...pdf.matchAll(/\/Artifact BMC\n([\s\S]*?)\nEMC/g)];
    expect(artifacts).toHaveLength(8);
    for (const [, commands] of artifacts) {
      expect(commands).toContain("0.4 g");
      expect(commands).toMatch(/\d+ m\n/);
      expect(commands).not.toMatch(/\bBT\b|\bTj\b|\bTJ\b|ActualText|MCID/);
    }
    expect(pdf).not.toContain("cheese sweet tobacco anchor");
    expect(pdf).not.toContain("/Type /StructElem");
    for (const character of " BP1234/abcdefghijklmnopqrstuvwxyz")
      expect(Object.hasOwn(regular.artifactOutlines, character)).toBe(true);

    const page = new PdfDocument("Letter").addPage();
    for (const words of [
      "cheese sweet tobacco",
      "Cheese sweet tobacco anchor",
      "cheese sweet tobacco anchor extra",
      "cheese sweet tobacco /anchor",
      "cheese sweet tobacco too-long-word",
    ])
      expect(() => page.backupLabel(words, 34, 16, 8.5)).toThrow(/label/);
    expect(() =>
      page.backupLabel("cheese sweet tobacco anchor", 600, 16, 8.5),
    ).toThrow(/bounds/);
    expect(() => page.footer("Page 5/4", 34, 30, 9)).toThrow(/label/);
  });
});
