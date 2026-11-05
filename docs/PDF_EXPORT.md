# PDF export

Paperwarden generates its four-page PDF locally, without browser printing or a
PDF dependency. Select A4 or US Letter before saving. Given the same encrypted
backup, export implementation, and paper size, the output bytes are identical:
viewport, orientation, browser fonts, zoom, and accessibility text size are not
layout inputs. No plaintext message or password is included.

The document contains a cover with the app's logo and a vector QR, two pages of
text archive, and a technical recovery reference. Archive rows have fixed
positions and do not wrap. The QR and archive encode the same encrypted bytes.
Upright multiline text uses explicit PDF line breaks; each archive row is
emitted as a complete text string.
The four italic Backup ID words sit at the left of every footer, with the page
number aligned right on the same baseline. The cover's ID is selectable text. Repeated
IDs and page numbers are vector outlines marked as artifacts, so text extractors
cannot insert them into the archive. The continuation
page has no selectable heading inside that block.
The recovery parser verifies the format and checksums.
The [public recovery example](RECOVERY_EXAMPLE.md) supplies known intermediate
values for checking an independent reader against the printed reference.
That reference defines the circular reads, all 2,834 candidate header starts,
key derivation, exact authentication inputs, and rejection rules needed to open
a message without the original app.

## Implementation boundary

[`src/print/backup.ts`](../src/print/backup.ts) defines the layout.
[`src/print/pdf.ts`](../src/print/pdf.ts) writes a restricted PDF 1.7 document:
text, rectangles, paths, embedded fonts, page objects, and a structure tree. It
does not parse PDFs, fonts, SVG, images, or HTML. Text is encoded as explicit CIDs
with `CIDToGIDMap`, widths, and `ToUnicode` mappings. There is no runtime shaping
or ligature substitution. Unsupported characters and out-of-page layout fail
instead of silently changing the document.

Headings, paragraphs, and the QR have logical tags; decorative paths and repeated
footer labels are artifacts. This is not a claim of PDF/UA conformance. The document
contains no JavaScript, actions, forms, attachments, remote resources, timestamps,
or random metadata. The exporter runs in the app's JavaScript context: receiving
only encrypted bytes does **not** isolate code from secrets elsewhere in that
page. Changes to it require the same source review as other application code.

## Why direct generation

Print CSS can remove viewport-dependent heights and improve page breaks, but
cannot force native print-dialog margins, paper selection, scaling, decorations,
or font-to-text mappings across browsers. Those controls cannot meet the fixed
layout requirement. Direct PDF generation makes the document independent of
native printing. Its `PrintScaling: None` preference is advisory; a PDF viewer or
printer can still rescale pages. Print at actual size and test the physical QR.

The November 2026 review compared these browser bundles, including required font
processing but excluding font assets. Sizes are unminified esbuild output for a
minimal document entry point, not package download sizes.

| Candidate         | Reviewed version               |  Bundle | Assessment                                                                                                                        |
| ----------------- | ------------------------------ | ------: | --------------------------------------------------------------------------------------------------------------------------------- |
| PDFKit            | 0.20.2, fontkit 2.0.4          | 1.01 MB | Maintained; supports tagging and font embedding, but adds 20 installed packages and general font/image/document machinery.        |
| pdf-lib + fontkit | 1.17.1, @pdf-lib/fontkit 1.1.1 | 2.19 MB | Custom fonts require a separate font parser; tagging requires low-level structure work. Published versions date to 2021 and 2020. |
| jsPDF             | 4.2.1                          | 1.53 MB | Broader plugin surface than this document needs; the reviewed version includes its published security fixes.                      |

The isolated installation's npm audit and exact-version OSV queries reported no
known advisories for these versions. That is neither a security approval nor a
substitute for inspecting shipped code. See the primary sources for
[PDFKit's tagging support](https://pdfkit.org/docs/accessibility.html),
[pdf-lib's font requirements](https://github.com/Hopding/pdf-lib#embed-font-and-measure-text),
and [jsPDF's patched advisory](https://github.com/parallax/jsPDF/security/advisories/GHSA-wfv2-pwc8-crg5).

A constrained writer avoids those runtime parsers for this fixed document.
Custom serialization is not inherently safer: this project owns correctness of
stream lengths, cross-references, font mapping, tagging, and pagination. Tests
must cover those boundaries, independent extraction/rendering, and actual device
save/open/share behavior. Browser-engine automation is not an iPhone Safari test.

## Font assets

The committed JSON in [`src/print/fonts`](../src/print/fonts) contains three
prepared TrueType fonts, metrics, Unicode mappings, and footer-label outlines.
Roboto regular and bold come from the existing app fonts. The monospaced archive
font comes from the unmodified [Liberation Mono 2.1.5 release](https://github.com/liberationfonts/liberation-fonts/releases/tag/2.1.5).
The modified fonts are renamed Paperwarden Print Regular, Bold, and Mono. Their
source and output SHA-256 values are recorded in each JSON file; source hashes
are enforced by the generator. Licenses are included in the project notices and
the font directory.

Ordinary builds use these assets without Python, font downloads, or font parsing.
To regenerate them, extract `LiberationMono-Regular.ttf` from the upstream
`liberation-fonts-ttf-2.1.5.tar.gz`, then use an isolated Python environment:

```sh
python3 -m venv /tmp/paperwarden-fonts
/tmp/paperwarden-fonts/bin/pip install fonttools==4.63.0 brotli==1.2.1
/tmp/paperwarden-fonts/bin/python scripts/generate-pdf-fonts.py \
  --mono-source /path/to/LiberationMono-Regular.ttf
npx prettier --write src/print/fonts/*.json
```

The source TTF SHA-256 is
`f2b83c763e8afd21709333370bed4774337fae82267937e2b5aea7e2fbd922c1`.
Generation covers printable ASCII and the fixed punctuation used by the layout;
it does not process user-provided fonts or arbitrary message text.
