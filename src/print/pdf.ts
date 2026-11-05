import regular from "./fonts/regular.json" with { type: "json" };
import bold from "./fonts/bold.json" with { type: "json" };
import mono from "./fonts/mono.json" with { type: "json" };

/** This writer emits only Paperwarden's fixed document; it never reads PDFs or fonts. */
export const PDF_EXPORT_VERSION = "1";
export type PaperSize = "A4" | "Letter";
export type PdfFont = "regular" | "bold" | "mono";
export type FontName = PdfFont;
export type PdfColor = number | readonly [number, number, number];
export type PdfRole = "P" | "H1" | "H2" | "H3";

export interface PdfDimensions {
  readonly width: number;
  readonly height: number;
}
export const PDF_SIZE: Readonly<Record<PaperSize, PdfDimensions>> = {
  A4: { width: 210 * (72 / 25.4), height: 297 * (72 / 25.4) },
  Letter: { width: 612, height: 792 },
};
export function pdfDimensions(size: PaperSize): PdfDimensions {
  if (size !== "A4" && size !== "Letter")
    throw new Error("Unsupported paper size");
  return PDF_SIZE[size];
}

interface FontData {
  postscriptName: string;
  unitsPerEm: number;
  ascent: number;
  descent: number;
  capHeight: number;
  bbox: number[];
  characters: Record<string, number[]>; // CID, subset glyph ID, advance width
  artifactOutlines: Record<string, (string | number)[][]>;
  data: string;
}
const fonts: Record<PdfFont, FontData> = { regular, bold, mono };
const fontNames: Record<PdfFont, string> = {
  regular: "FR",
  bold: "FB",
  mono: "FM",
};

function fontFor(name: PdfFont): FontData {
  if (!Object.hasOwn(fonts, name)) throw new Error("Unsupported PDF font");
  const font = fonts[name];
  if (!font) throw new Error("Unsupported PDF font");
  return font;
}
function glyphs(text: string, font: FontData): number[][] {
  return Array.from(text, (character) => {
    const glyph = font.characters[character];
    if (!glyph) throw new Error("Unsupported character in PDF text");
    return glyph;
  });
}
function positive(value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > 1000)
    throw new Error("Invalid PDF dimension");
}
export function measure(
  text: string,
  size: number,
  font: PdfFont = "regular",
): number {
  positive(size);
  const data = fontFor(font);
  return (
    (glyphs(text, data).reduce((sum, glyph) => sum + glyph[2], 0) * size) /
    data.unitsPerEm
  );
}
function number(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) > 10_000_000)
    throw new Error("Invalid PDF number");
  const rounded = value.toFixed(6).replace(/\.?0+$/, "");
  return rounded === "-0" || rounded === "" ? "0" : rounded;
}
function hex16(value: number): string {
  return value.toString(16).padStart(4, "0").toUpperCase();
}
function unicodeHex(text: string): string {
  // PDF text strings are UTF-16BE with a BOM; content text uses explicit CIDs instead.
  let result = "FEFF";
  for (let index = 0; index < text.length; index++)
    result += hex16(text.charCodeAt(index));
  return `<${result}>`;
}
function ascii(text: string): Uint8Array {
  for (let index = 0; index < text.length; index++)
    if (text.charCodeAt(index) > 127) throw new Error("Non-ASCII PDF syntax");
  return new TextEncoder().encode(text);
}
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
class Ref {
  constructor(readonly id: number) {}
}
class Name {
  constructor(readonly value: string) {
    if (!/^[A-Za-z0-9_.+-]+$/.test(value)) throw new Error("Invalid PDF name");
  }
}
class Text {
  constructor(readonly value: string) {}
}
class BytesText {
  constructor(readonly value: string) {
    if (/[^\x20-\x7E]/.test(value)) throw new Error("Invalid PDF byte string");
  }
}
type Value =
  | null
  | boolean
  | number
  | Ref
  | Name
  | Text
  | BytesText
  | Value[]
  | { [key: string]: Value };
interface Stream {
  dictionary: { [key: string]: Value };
  bytes: Uint8Array;
}
function serialize(value: Value): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return number(value);
  if (value instanceof Ref) return `${value.id} 0 R`;
  if (value instanceof Name) return "/" + value.value;
  if (value instanceof Text) return unicodeHex(value.value);
  if (value instanceof BytesText)
    return "(" + value.value.replace(/[\\()]/g, "\\$&") + ")";
  if (Array.isArray(value)) return "[" + value.map(serialize).join(" ") + "]";
  return (
    "<< " +
    Object.entries(value)
      .map(([key, item]) => `${serialize(new Name(key))} ${serialize(item)}`)
      .join(" ") +
    " >>"
  );
}
class Objects {
  private readonly entries: (Value | Stream | undefined)[] = [];
  reserve(): Ref {
    this.entries.push(undefined);
    return new Ref(this.entries.length);
  }
  set(ref: Ref, value: Value | Stream): void {
    if (
      ref.id < 1 ||
      ref.id > this.entries.length ||
      this.entries[ref.id - 1] !== undefined
    )
      throw new Error("Invalid PDF object assignment");
    this.entries[ref.id - 1] = value;
  }
  add(value: Value): Ref {
    const ref = this.reserve();
    this.set(ref, value);
    return ref;
  }
  stream(bytes: Uint8Array, dictionary: Stream["dictionary"] = {}): Ref {
    const ref = this.reserve();
    this.set(ref, { dictionary, bytes });
    return ref;
  }
  save(root: Ref, info: Ref): Uint8Array {
    const chunks = [
      ascii("%PDF-1.7\n%"),
      new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3, 10]),
    ];
    let offset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const offsets = [0];
    for (let index = 0; index < this.entries.length; index++) {
      const object = this.entries[index];
      if (object === undefined) throw new Error("Unassigned PDF object");
      offsets.push(offset);
      const parts = [ascii(`${index + 1} 0 obj\n`)];
      if (
        object &&
        typeof object === "object" &&
        "bytes" in object &&
        object.bytes instanceof Uint8Array
      ) {
        const stream = object as Stream;
        parts.push(
          ascii(
            serialize({ ...stream.dictionary, Length: stream.bytes.length }) +
              "\nstream\n",
          ),
          stream.bytes,
          ascii("\nendstream"),
        );
      } else parts.push(ascii(serialize(object as Value)));
      parts.push(ascii("\nendobj\n"));
      chunks.push(...parts);
      offset += parts.reduce((sum, part) => sum + part.length, 0);
    }
    if (offset > 9_999_999_999)
      throw new Error("PDF exceeds cross-reference limit");
    const xref =
      offsets
        .map(
          (position, index) =>
            `${String(position).padStart(10, "0")} ${index ? "00000 n" : "65535 f"} `,
        )
        .join("\n") + "\n";
    chunks.push(
      ascii(
        `xref\n0 ${offsets.length}\n${xref}trailer\n${serialize({ Size: offsets.length, Root: root, Info: info })}\nstartxref\n${offset}\n%%EOF\n`,
      ),
    );
    return concat(chunks);
  }
}
function embedFont(objects: Objects, name: PdfFont): Ref {
  const data = fontFor(name);
  const bytes = Uint8Array.from(atob(data.data), (character) =>
    character.charCodeAt(0),
  );
  const file = objects.stream(bytes, { Length1: bytes.length });
  const scale = 1000 / data.unitsPerEm;
  const descriptor = objects.add({
    Type: new Name("FontDescriptor"),
    FontName: new Name(data.postscriptName),
    Flags: name === "mono" ? 33 : 32,
    FontBBox: data.bbox.map((value) => value * scale),
    ItalicAngle: 0,
    Ascent: data.ascent * scale,
    Descent: data.descent * scale,
    CapHeight: data.capHeight * scale,
    StemV: name === "bold" ? 120 : 80,
    FontFile2: file,
  });
  const entries = Object.entries(data.characters);
  const map = new Uint8Array((entries.length + 1) * 2);
  const widths: number[] = [];
  const unicode: string[] = [];
  for (const [character, [cid, gid, advance]] of entries) {
    map[cid * 2] = gid >> 8;
    map[cid * 2 + 1] = gid & 255;
    widths[cid - 1] = advance * scale;
    unicode.push(`<${hex16(cid)}> <${hex16(character.charCodeAt(0))}>`);
  }
  const descendant = objects.add({
    Type: new Name("Font"),
    Subtype: new Name("CIDFontType2"),
    BaseFont: new Name(data.postscriptName),
    CIDSystemInfo: {
      Registry: new BytesText("Adobe"),
      Ordering: new BytesText("Identity"),
      Supplement: 0,
    },
    FontDescriptor: descriptor,
    DW: 0,
    W: [1, widths],
    CIDToGIDMap: objects.stream(map),
  });
  const batches: string[] = [];
  // ISO 32000 CMap operators accept at most 100 mappings per batch.
  for (let index = 0; index < unicode.length; index += 100) {
    const batch = unicode.slice(index, index + 100);
    batches.push(`${batch.length} beginbfchar\n${batch.join("\n")}\nendbfchar`);
  }
  const toUnicode = objects.stream(
    ascii(
      `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /PaperwardenUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${batches.join("\n")}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n`,
    ),
  );
  return objects.add({
    Type: new Name("Font"),
    Subtype: new Name("Type0"),
    BaseFont: new Name(data.postscriptName),
    Encoding: new Name("Identity-H"),
    DescendantFonts: [descendant],
    ToUnicode: toUnicode,
  });
}
function color(value: PdfColor = 0, stroke = false): string {
  const values = typeof value === "number" ? [value] : value;
  if (
    (values.length !== 1 && values.length !== 3) ||
    values.some((item) => !Number.isFinite(item) || item < 0 || item > 1)
  )
    throw new Error("Invalid PDF color");
  return (
    values.map(number).join(" ") +
    " " +
    (values.length === 1 ? (stroke ? "G" : "g") : stroke ? "RG" : "rg")
  );
}
export interface PdfTextOptions {
  x: number;
  y: number;
  size: number;
  leading: number;
  font?: PdfFont;
  italic?: boolean;
  role: PdfRole;
  color?: PdfColor;
}
export interface PdfTextRun {
  text: string;
  options: Omit<PdfTextOptions, "role">;
}
export interface PdfPaint {
  fill?: PdfColor;
  stroke?: PdfColor;
  lineWidth?: number;
  dash?: readonly number[];
}
interface Structure {
  ref: Ref;
  role: PdfRole | "Figure";
  mcid: number;
  alt?: string;
}

export class PdfPage {
  private readonly commands: string[] = [];
  private readonly structure: Structure[] = [];
  private inFigure = false;
  constructor(
    private readonly document: PdfDocument,
    readonly width: number,
    readonly height: number,
    readonly ref: Ref,
  ) {}
  private bounds(x: number, y: number, width: number, height: number): void {
    if (
      ![x, y, width, height].every(Number.isFinite) ||
      x < 0 ||
      y < 0 ||
      width < 0 ||
      height < 0 ||
      x + width > this.width + 0.01 ||
      y + height > this.height + 0.01
    )
      throw new Error("PDF content exceeds page bounds");
  }
  private marked(
    role: Structure["role"],
    draw: () => void,
    alt?: string,
    actualText?: string,
  ): void {
    this.document.assertOpen();
    if (this.inFigure) throw new Error("Nested PDF structure is not supported");
    const element = {
      ref: this.document.objects.reserve(),
      role,
      mcid: this.structure.length,
      alt,
    };
    this.structure.push(element);
    this.commands.push(
      `/${role} << /MCID ${element.mcid}${actualText === undefined ? "" : " /ActualText " + unicodeHex(actualText)} >> BDC`,
    );
    try {
      draw();
      this.commands.push("EMC");
    } catch (error) {
      this.document.invalidate();
      throw error;
    }
  }
  private textCommands(
    lines: readonly string[],
    options: Omit<PdfTextOptions, "role">,
  ): string[] {
    const { x, y, size, leading, italic = false } = options;
    const font = options.font ?? "regular";
    positive(size);
    positive(leading);
    if (lines.length === 0) throw new Error("Invalid PDF text block");
    const data = fontFor(font);
    const baseline = (data.ascent * size) / data.unitsPerEm;
    const descent = (-data.descent * size) / data.unitsPerEm;
    for (let index = 0; index < lines.length; index++)
      this.bounds(
        x,
        y + leading * index,
        measure(lines[index], size, font),
        baseline + descent,
      );
    const commands = [
      "q",
      color(options.color),
      "BT",
      `/${fontNames[font]} ${number(size)} Tf`,
      `${number(leading)} TL`,
    ];
    for (let index = 0; index < lines.length; index++) {
      const encoded = glyphs(lines[index], data)
        .map(([cid]) => hex16(cid))
        .join("");
      // Advance upright text as one flow. A skewed italic matrix needs an
      // absolute position to keep subsequent lines from drifting sideways.
      commands.push(
        index === 0 || italic
          ? `1 0 ${italic ? "0.2" : "0"} 1 ${number(x)} ${number(this.height - y - baseline - leading * index)} Tm`
          : "T*",
        `<${encoded}> Tj`,
      );
    }
    return [...commands, "ET", "Q"];
  }
  /** y is the top of the font's em box; each subsequent line advances by leading. */
  text(lines: readonly string[], options: PdfTextOptions): void {
    if (!["P", "H1", "H2", "H3"].includes(options.role))
      throw new Error("Invalid PDF text role");
    const commands = this.textCommands(lines, options);
    this.marked(options.role, () => this.commands.push(...commands));
  }
  /** Adjacent styled runs form one logical text element, in supplied reading order. */
  textRuns(runs: readonly PdfTextRun[], role: PdfRole): void {
    if (!["P", "H1", "H2", "H3"].includes(role) || runs.length === 0)
      throw new Error("Invalid PDF text runs");
    const commands = runs.flatMap(({ text, options }) =>
      this.textCommands([text], options),
    );
    this.marked(
      role,
      () => this.commands.push(...commands),
      undefined,
      runs.map((run) => run.text).join(""),
    );
  }
  private paint(path: string, options: PdfPaint): void {
    this.document.assertOpen();
    const { fill, stroke, lineWidth = 1, dash = [] } = options;
    if (fill === undefined && stroke === undefined)
      throw new Error("Unpainted PDF path");
    positive(lineWidth);
    if (
      dash.length > 8 ||
      dash.some((item) => !Number.isFinite(item) || item <= 0)
    )
      throw new Error("Invalid PDF dash");
    const paintOptions: string[] = [];
    if (fill !== undefined) paintOptions.push(color(fill));
    if (stroke !== undefined)
      paintOptions.push(
        color(stroke, true),
        `${number(lineWidth)} w`,
        `[${dash.map(number).join(" ")}] 0 d`,
      );
    if (!this.inFigure) this.commands.push("/Artifact BMC");
    this.commands.push(
      "q",
      `1 0 0 -1 0 ${number(this.height)} cm`,
      ...paintOptions,
    );
    this.commands.push(
      path,
      fill !== undefined ? (stroke !== undefined ? "B" : "f") : "S",
      "Q",
    );
    if (!this.inFigure) this.commands.push("EMC");
  }
  rect(
    x: number,
    y: number,
    width: number,
    height: number,
    options: PdfPaint,
  ): void {
    this.bounds(x, y, width, height);
    this.paint(`${[x, y, width, height].map(number).join(" ")} re`, options);
  }
  /** Paint same-style rectangles together, without a graphics-state pair per QR run. */
  rectangles(
    rectangles: readonly (readonly [number, number, number, number])[],
    options: PdfPaint,
  ): void {
    if (rectangles.length === 0) throw new Error("Empty PDF rectangle group");
    const paths = rectangles.map(([x, y, width, height]) => {
      this.bounds(x, y, width, height);
      return `${[x, y, width, height].map(number).join(" ")} re`;
    });
    this.paint(paths.join("\n"), options);
  }
  /** Trusted m/l/c/h PDF path operators only; all coordinates are top-down points. */
  path(commands: string, options: PdfPaint): void {
    const tokens = commands.trim().split(/\s+/);
    let values: number[] = [];
    let hasMove = false;
    for (const token of tokens) {
      if (/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(token)) {
        values.push(Number(token));
      } else {
        const count =
          token === "m" || token === "l"
            ? 2
            : token === "c"
              ? 6
              : token === "h"
                ? 0
                : -1;
        if (count < 0 || values.length !== count || (!hasMove && token !== "m"))
          throw new Error("Invalid PDF path");
        for (let i = 0; i < values.length; i += 2)
          this.bounds(values[i], values[i + 1], 0, 0);
        if (token === "m") hasMove = true;
        values = [];
      }
    }
    if (!hasMove || values.length) throw new Error("Incomplete PDF path");
    this.paint(commands, options);
  }
  figure(alt: string, draw: () => void): void {
    if (!alt || alt.length > 512)
      throw new Error("Invalid PDF figure description");
    this.marked(
      "Figure",
      () => {
        this.inFigure = true;
        try {
          draw();
        } finally {
          this.inFigure = false;
        }
      },
      alt,
    );
  }
  private outlineLabel(
    runs: readonly { text: string; italic?: boolean }[],
    x: number,
    y: number,
    size: number,
  ): void {
    positive(size);
    this.bounds(
      x,
      y,
      measure(runs.map((run) => run.text).join(""), size),
      ((regular.ascent - regular.descent) * size) / regular.unitsPerEm,
    );
    const scale = size / regular.unitsPerEm;
    const baseline = y + regular.ascent * scale;
    const paths: string[] = [];
    let cursor = x;
    for (const { text, italic = false } of runs) {
      for (const character of text) {
        const outline = fonts.regular.artifactOutlines[character];
        if (!outline) throw new Error("Missing label outline");
        for (const [operator, ...coordinates] of outline) {
          const points: number[] = [];
          for (let index = 0; index < coordinates.length; index += 2) {
            const glyphX = coordinates[index] as number;
            const glyphY = coordinates[index + 1] as number;
            const px = cursor + (glyphX + (italic ? 0.2 * glyphY : 0)) * scale;
            const py = baseline - glyphY * scale;
            this.bounds(px, py, 0, 0);
            points.push(px, py);
          }
          paths.push(
            points.map(number).join(" ") +
              (points.length ? " " : "") +
              operator,
          );
        }
        cursor += fonts.regular.characters[character][2] * scale;
      }
    }
    this.paint(paths.join("\n"), { fill: 0.4 });
  }
  /** Repeated Backup IDs are outlined artifacts, never text inside the archive. */
  backupLabel(words: string, x: number, y: number, size: number): void {
    if (!/^[a-z]{3,8}(?: [a-z]{3,8}){3}$/.test(words))
      throw new Error("Invalid PDF backup label");
    this.outlineLabel([{ text: words, italic: true }], x, y, size);
  }
  /** Outlined pagination is an artifact, not selectable text inside the archive. */
  footer(text: string, x: number, y: number, size: number): void {
    if (!/^Page [1-4]\/4$/.test(text))
      throw new Error("Invalid PDF page label");
    this.outlineLabel([{ text }], x, y, size);
  }
  finish(
    parent: Ref,
    structureRoot: Ref,
    parentKey: number,
    fontRefs: Record<string, Ref>,
  ): Ref[] {
    const content = this.document.objects.stream(
      ascii(this.commands.join("\n") + "\n"),
    );
    this.document.objects.set(this.ref, {
      Type: new Name("Page"),
      Parent: parent,
      MediaBox: [0, 0, this.width, this.height],
      Contents: content,
      Resources: { Font: fontRefs },
      StructParents: parentKey,
      Tabs: new Name("S"),
    });
    for (const element of this.structure)
      this.document.objects.set(element.ref, {
        Type: new Name("StructElem"),
        S: new Name(element.role),
        P: structureRoot,
        Pg: this.ref,
        K: element.mcid,
        ...(element.alt ? { Alt: new Text(element.alt) } : {}),
      });
    return this.structure.map((element) => element.ref);
  }
}

export class PdfDocument {
  readonly objects = new Objects();
  private readonly pages: PdfPage[] = [];
  private saved = false;
  private failed = false;
  readonly width: number;
  readonly height: number;
  constructor(size: PaperSize) {
    ({ width: this.width, height: this.height } = pdfDimensions(size));
  }
  assertOpen(): void {
    if (this.saved) throw new Error("PDF is already finalized");
    if (this.failed) throw new Error("PDF drawing failed");
  }
  invalidate(): void {
    this.failed = true;
  }
  addPage(): PdfPage {
    this.assertOpen();
    if (this.pages.length >= 4)
      throw new Error("Paperwarden PDF has four pages");
    const page = new PdfPage(
      this,
      this.width,
      this.height,
      this.objects.reserve(),
    );
    this.pages.push(page);
    return page;
  }
  save(): Uint8Array {
    this.assertOpen();
    if (this.pages.length !== 4)
      throw new Error("Paperwarden PDF requires four pages");
    const tree = this.objects.reserve();
    const structure = this.objects.reserve();
    const fontRefs = Object.fromEntries(
      (Object.keys(fonts) as PdfFont[]).map((font) => [
        fontNames[font],
        embedFont(this.objects, font),
      ]),
    );
    const childRefs: Ref[] = [];
    const parentTree: Value[] = [];
    for (let index = 0; index < this.pages.length; index++) {
      const elements = this.pages[index].finish(
        tree,
        structure,
        index,
        fontRefs,
      );
      childRefs.push(...elements);
      parentTree.push(index, elements);
    }
    this.objects.set(tree, {
      Type: new Name("Pages"),
      Count: 4,
      Kids: this.pages.map((page) => page.ref),
    });
    this.objects.set(structure, {
      Type: new Name("StructTreeRoot"),
      K: childRefs,
      ParentTree: this.objects.add({ Nums: parentTree }),
      ParentTreeNextKey: 4,
    });
    const root = this.objects.add({
      Type: new Name("Catalog"),
      Pages: tree,
      Lang: new Text("en"),
      MarkInfo: { Marked: true },
      StructTreeRoot: structure,
      ViewerPreferences: {
        DisplayDocTitle: true,
        PrintScaling: new Name("None"),
      },
    });
    const info = this.objects.add({
      Title: new Text("Paperwarden encrypted backup"),
      Creator: new Text("Paperwarden"),
      Producer: new Text(`Paperwarden PDF export ${PDF_EXPORT_VERSION}`),
    });
    this.saved = true;
    return this.objects.save(root, info);
  }
}
