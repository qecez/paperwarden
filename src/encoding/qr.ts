import QRCode, { type QRCodeSegment } from "qrcode";
import {
  BinaryBitmap,
  BitMatrix,
  DecodeHintType,
  HybridBinarizer,
  QRCodeReader,
  RGBLuminanceSource,
} from "@zxing/library";
import FinderPatternFinder from "@zxing/library/esm/core/qrcode/detector/FinderPatternFinder";
import { PaperError } from "../crypto/errors";
import { encodeTransport } from "./transport";
import { decodeQrPayload, encodeLink, RADIX43_CHARACTERS } from "./link";

export const QR_VERSION = 40;
export const QR_CORRECTION = "L";
export const QR_QUIET_ZONE = 4;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
export const MAX_SCAN_DIMENSION = 2400;
export type QrOptions = { includeLink?: boolean };

/** Every envelope produces the same 177 × 177 symbol, even for a short message. */
export function qrMatrix(bytes: Uint8Array, options: QrOptions = {}) {
  let segments: QRCodeSegment[];
  if (options.includeLink !== false) {
    const link = encodeLink(bytes);
    const prefixLength = link.length - RADIX43_CHARACTERS;
    // Explicit segments avoid byte mode for the dense, URL-safe payload.
    segments = [
      {
        data: new TextEncoder().encode(link.slice(0, prefixLength)),
        mode: "byte",
      },
      { data: link.slice(prefixLength), mode: "alphanumeric" },
    ];
  } else {
    segments = [{ data: encodeTransport(bytes), mode: "alphanumeric" }];
  }
  try {
    return QRCode.create(segments, {
      version: QR_VERSION,
      errorCorrectionLevel: QR_CORRECTION,
    });
  } catch {
    throw new PaperError("qr");
  }
}

export function qrSvg(bytes: Uint8Array, options: QrOptions = {}): string {
  const { modules } = qrMatrix(bytes, options);
  const side = modules.size + 2 * QR_QUIET_ZONE;
  // Horizontal runs reduce SVG size without introducing interpolation or seams.
  let path = "";
  for (let y = 0; y < modules.size; y++) {
    let x = 0;
    while (x < modules.size) {
      if (!modules.get(y, x)) {
        x++;
        continue;
      }
      const start = x++;
      while (x < modules.size && modules.get(y, x)) x++;
      path += `M${start + QR_QUIET_ZONE} ${y + QR_QUIET_ZONE}h${x - start}v1H${start + QR_QUIET_ZONE}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d="${path}" fill="black"/></svg>`;
}

const QR_MODULES = 177;
const FINDER_DISTANCE = QR_MODULES - 7;
const MAX_FINDER_CANDIDATES = 128;
const MAX_GRID_ATTEMPTS = 16;

/**
 * ZXing's generic finder can prefer interior patterns in a dense version-40 QR.
 * Its early row skips can also miss real corners. This bounded second pass uses
 * the protected cross-check APIs of our pinned ZXing version, without its early
 * selection. Ordinary detection, including perspective correction, runs first.
 */
class DenseFinder extends FinderPatternFinder {
  candidates() {
    const image = this.getImage();
    for (let y = 1; y < image.getHeight(); y += 2) {
      const counts = new Int32Array(5);
      let runCount = 0;
      let previous = false;
      let count = 0;
      for (let x = 0; x <= image.getWidth(); x++) {
        const black = x < image.getWidth() && image.get(x, y);
        if (black === previous) {
          count++;
          continue;
        }
        if (runCount < 5) counts[runCount++] = count;
        else {
          counts[0] = counts[1];
          counts[1] = counts[2];
          counts[2] = counts[3];
          counts[3] = counts[4];
          counts[4] = count;
        }
        if (previous && runCount === 5) {
          if (DenseFinder.foundPatternCross(counts)) {
            this.handlePossibleCenter(counts, y, x, false);
            if (this.getPossibleCenters().length > MAX_FINDER_CANDIDATES)
              return [];
          }
        }
        previous = black;
        count = 1;
      }
    }
    return this.getPossibleCenters()
      .sort((a, b) => b.getCount() - a.getCount())
      .slice(0, 32);
  }
}

// QRCodeReader exposes its checksum-validating matrix decoder to subclasses.
class MatrixReader extends QRCodeReader {
  read(matrix: BitMatrix): string {
    return this.getDecoder().decodeBitMatrix(matrix).getText();
  }
}

/** Fixed-size affine fallback for flat scans and PDF rasterizations. */
function decodeDenseGrid(bitmap: BinaryBitmap): string | null {
  const image = bitmap.getBlackMatrix();
  const candidates = new DenseFinder(image, {
    foundPossibleResultPoint() {},
  }).candidates();
  const reader = new MatrixReader();
  let attempts = 0;
  for (const a of candidates) {
    for (const b of candidates) {
      if (a === b) continue;
      const dx = b.getX() - a.getX();
      const dy = b.getY() - a.getY();
      const ab = Math.hypot(dx, dy);
      const module = ab / FINDER_DISTANCE;
      if (
        module < 2 ||
        Math.abs(module / a.getEstimatedModuleSize() - 1) > 0.2 ||
        Math.abs(module / b.getEstimatedModuleSize() - 1) > 0.2
      )
        continue;
      for (const c of candidates) {
        if (c === a || c === b) continue;
        const ex = c.getX() - a.getX();
        const ey = c.getY() - a.getY();
        const ac = Math.hypot(ex, ey);
        // Corner order, near-equal legs and a near-right angle establish the
        // expected 170-module separation before any matrix decoding is tried.
        if (
          dx * ey - dy * ex <= 0 ||
          Math.abs(ac / ab - 1) > 0.15 ||
          Math.abs((dx * ex + dy * ey) / (ac * ab)) > 0.1 ||
          Math.abs(ac / FINDER_DISTANCE / c.getEstimatedModuleSize() - 1) > 0.2
        )
          continue;
        if (++attempts > MAX_GRID_ATTEMPTS) return null;
        const matrix = new BitMatrix(QR_MODULES);
        let inBounds = true;
        for (let y = 0; y < QR_MODULES && inBounds; y++) {
          for (let x = 0; x < QR_MODULES; x++) {
            // Finder centers are at module (3.5, 3.5); sample module centers.
            const sx = Math.floor(
              a.getX() + ((x - 3) * dx + (y - 3) * ex) / FINDER_DISTANCE,
            );
            const sy = Math.floor(
              a.getY() + ((x - 3) * dy + (y - 3) * ey) / FINDER_DISTANCE,
            );
            if (
              sx < 0 ||
              sy < 0 ||
              sx >= image.getWidth() ||
              sy >= image.getHeight()
            ) {
              inBounds = false;
              break;
            }
            if (image.get(sx, sy)) matrix.set(x, y);
          }
        }
        if (!inBounds) continue;
        try {
          return reader.read(matrix);
        } catch {
          // Reject geometrically plausible but checksum-invalid grids.
        }
      }
    }
  }
  return null;
}

function decodeLuminance(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array | null {
  const bitmap = new BinaryBitmap(
    new HybridBinarizer(new RGBLuminanceSource(pixels, width, height)),
  );
  for (const hint of [DecodeHintType.TRY_HARDER, DecodeHintType.PURE_BARCODE]) {
    let text: string;
    try {
      text = new QRCodeReader()
        .decode(bitmap, new Map([[hint, true]]))
        .getText();
    } catch {
      continue;
    }
    // A decoded, unsupported or malformed backup is not a missed QR detection.
    return decodeQrPayload(text);
  }
  let text: string | null;
  try {
    text = decodeDenseGrid(bitmap);
  } catch {
    return null;
  }
  return text === null ? null : decodeQrPayload(text);
}

/** Decodes bounded RGBA pixels. Multiple scales help with grid/pixel alignment. */
export function scanPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array | null {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_SCAN_DIMENSION ||
    height > MAX_SCAN_DIMENSION ||
    data.length !== width * height * 4
  ) {
    throw new PaperError("format");
  }
  const luminance = new Uint8ClampedArray(width * height);
  for (let pixel = 0; pixel < luminance.length; pixel++) {
    const offset = pixel * 4;
    // Alpha is composited over white, matching the printed quiet zone.
    const gray = (data[offset] + 2 * data[offset + 1] + data[offset + 2]) / 4;
    luminance[pixel] = Math.round(
      255 + ((gray - 255) * data[offset + 3]) / 255,
    );
  }
  const full = decodeLuminance(luminance, width, height);
  if (full) return full;
  for (const scale of [0.66, 0.5, 0.33]) {
    const reducedWidth = Math.round(width * scale);
    const reducedHeight = Math.round(height * scale);
    if (Math.min(reducedWidth, reducedHeight) < 185) continue;
    const reduced = new Uint8ClampedArray(reducedWidth * reducedHeight);
    for (let y = 0; y < reducedHeight; y++) {
      for (let x = 0; x < reducedWidth; x++) {
        const sourceX = Math.min(width - 1, Math.floor(x / scale));
        const sourceY = Math.min(height - 1, Math.floor(y / scale));
        reduced[y * reducedWidth + x] = luminance[sourceY * width + sourceX];
      }
    }
    const found = decodeLuminance(reduced, reducedWidth, reducedHeight);
    if (found) return found;
  }
  return null;
}

/** Browser decoding can allocate before dimensions are known; the pixel cap is not an OOM guarantee. */
export async function scanFile(file: File): Promise<Uint8Array> {
  const svg =
    file.type === "image/svg+xml" ||
    (file.type === "" && /\.svg$/i.test(file.name));
  if (
    file.size === 0 ||
    file.size > MAX_IMAGE_BYTES ||
    (!svg &&
      !["image/png", "image/jpeg", "image/webp", "image/bmp"].includes(
        file.type,
      ))
  ) {
    throw new PaperError("format");
  }
  // SVG stays in the browser's passive image context: scripts and external
  // resources are disabled. Never insert its markup into a document or frame.
  // https://www.w3.org/TR/SVG/conform.html#secure-animated-mode
  const source =
    svg && file.type === ""
      ? new Blob([file], { type: "image/svg+xml" })
      : file;
  const url = URL.createObjectURL(source);
  const image = new Image();
  const canvas = document.createElement("canvas");
  try {
    image.src = url;
    await image.decode();
    const { naturalWidth: width, naturalHeight: height } = image;
    if (width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS)
      throw new PaperError("format");
    // ViewBox-only SVGs often have a 300px intrinsic size. Render vectors at
    // scan resolution instead of magnifying an undersampled QR bitmap later.
    const scale = svg
      ? MAX_SCAN_DIMENSION / Math.max(width, height)
      : Math.min(1, MAX_SCAN_DIMENSION / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new PaperError("resource");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const decoded = scanPixels(
      context.getImageData(0, 0, canvas.width, canvas.height).data,
      canvas.width,
      canvas.height,
    );
    if (!decoded) throw new PaperError("qr");
    return decoded;
  } catch (error) {
    if (error instanceof PaperError) throw error;
    throw new PaperError("format");
  } finally {
    canvas.width = canvas.height = 0;
    image.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
}
