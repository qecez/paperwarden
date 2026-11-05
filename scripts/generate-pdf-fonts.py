#!/usr/bin/env python3
"""Prepare fixed PDF fonts. Build-time only; the reader has no font parser.

Requires fonttools==4.63.0 and brotli==1.2.1. Supply the unmodified Liberation
Mono 2.1.5 regular TTF with --mono-source. Ordinary app builds use the committed
JSON and do not need Python or fetch any fonts.
"""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path

import fontTools
import brotli
from fontTools import subset
from fontTools.pens.basePen import BasePen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
FONTTOOLS_VERSION = "4.63.0"
CHARACTERS = "".join(chr(i) for i in range(32, 127)) + "\u00a0\u2013\u2014\u2018\u2019\u201c\u201d\u2026"
ARTIFACT_CHARACTERS = " BP1234/abcdefghijklmnopqrstuvwxyz"


class PdfPen(BasePen):
    """Trusted TrueType contours to PDF cubic paths, in font units."""
    def __init__(self, glyph_set):
        super().__init__(glyph_set)
        self.commands = []

    def emit(self, points, operator):
        self.commands.append([operator, *[round(value, 6) for point in points for value in point]])

    def _moveTo(self, point):
        self.emit([point], "m")

    def _lineTo(self, point):
        self.emit([point], "l")

    def _curveToOne(self, a, b, c):
        self.emit([a, b, c], "c")

    def _qCurveToOne(self, control, end):
        start = self._getCurrentPoint()
        first = tuple(start[i] + 2 * (control[i] - start[i]) / 3 for i in range(2))
        second = tuple(end[i] + 2 * (control[i] - end[i]) / 3 for i in range(2))
        self._curveToOne(first, second, end)

    def _closePath(self):
        self.commands.append(["h"])

    def _endPath(self):
        raise ValueError("Open contour in a trusted font")


def prepare(name, source, expected, output):
    source_bytes = source.read_bytes()
    digest = hashlib.sha256(source_bytes).hexdigest()
    if digest != expected:
        raise ValueError(f"Unexpected {name} source SHA-256: {digest}")
    font = TTFont(io.BytesIO(source_bytes), recalcTimestamp=False)
    font.flavor = None
    options = subset.Options()
    options.recalc_timestamp = False
    options.canonical_order = True
    options.layout_features = []
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    options.name_legacy = True
    options.name_languages = [0x409]
    # The output uses one Unicode code point per CID, with no ligatures/kerning.
    # Glyph rendering and widths are prepared once from these trusted assets.
    sub = subset.Subsetter(options=options)
    sub.populate(text=CHARACTERS)
    sub.subset(font)
    if "DSIG" in font:
        del font["DSIG"]
    # Modified SIL/OFL fonts must not retain reserved family names.
    family = "Paperwarden Print " + name.capitalize()
    postscript = "PaperwardenPrint" + name.capitalize()
    for record in font["name"].names:
        if record.nameID in [1, 3, 4, 6]:
            value = postscript if record.nameID == 6 else family
            record.string = value.encode(record.getEncoding())
    cmap = font.getBestCmap()
    missing = set(map(ord, CHARACTERS)) - set(cmap)
    if missing:
        raise ValueError(f"Missing PDF characters: {missing}")
    glyph_set = font.getGlyphSet()
    characters = {}
    for cid, character in enumerate(CHARACTERS, start=1):
        glyph = cmap[ord(character)]
        characters[character] = [cid, font.getGlyphID(glyph), font["hmtx"][glyph][0]]
    outlines = {}
    if name == "regular":
        for character in ARTIFACT_CHARACTERS:
            pen = PdfPen(glyph_set)
            glyph_set[cmap[ord(character)]].draw(pen)
            outlines[character] = pen.commands
    binary = io.BytesIO()
    font.save(binary, reorderTables=True)
    data = binary.getvalue()
    record = {
        "sourceSha256": digest,
        "fontSha256": hashlib.sha256(data).hexdigest(),
        "postscriptName": postscript,
        "unitsPerEm": font["head"].unitsPerEm,
        "ascent": font["hhea"].ascent,
        "descent": font["hhea"].descent,
        "capHeight": getattr(font["OS/2"], "sCapHeight", font["hhea"].ascent),
        "bbox": [font["head"].xMin, font["head"].yMin, font["head"].xMax, font["head"].yMax],
        "characters": characters,
        "artifactOutlines": outlines,
        "data": base64.b64encode(data).decode("ascii"),
    }
    output.write_text(json.dumps(record, ensure_ascii=True, separators=(",", ":")) + "\n")
    print(f"{name}: {len(data)} font bytes; {len(characters)} mapped characters; {record['fontSha256']}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mono-source", type=Path, required=True)
    parser.add_argument("--output", type=Path, default=ROOT / "src/print/fonts")
    args = parser.parse_args()
    if fontTools.__version__ != FONTTOOLS_VERSION:
        raise ValueError("Use fonttools==" + FONTTOOLS_VERSION)
    if brotli.__version__ != "1.2.1":
        raise ValueError("Use brotli==1.2.1")
    args.output.mkdir(parents=True, exist_ok=True)
    sources = [
        ("regular", ROOT / "src/app/fonts/roboto-regular.woff2", "cc46322d5c4d41da447f26f7fa714827f2ec9a112968c12ef5736c7494985eca"),
        ("bold", ROOT / "src/app/fonts/roboto-bold.woff2", "0eaeadb58e6995ba85eccb6198aaef77eeb1d4b66699e4e1f3fc10eb6adfcdb9"),
        ("mono", args.mono_source, "f2b83c763e8afd21709333370bed4774337fae82267937e2b5aea7e2fbd922c1"),
    ]
    for name, source, digest in sources:
        prepare(name, source, digest, args.output / (name + ".json"))


if __name__ == "__main__":
    main()
