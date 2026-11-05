import { create as createQr } from "qrcode/lib/core/qrcode";

/** Donation payment URIs only. Never used for the encrypted backup QR. */
export function donationQr(uri: string, logo: string, availablePixels: number) {
  // One grid size for all currencies keeps the QR and dialog geometry stable.
  const { modules } = createQr(uri, {
    version: 10,
    errorCorrectionLevel: "H",
  });
  const margin = 4;
  const side = modules.size + 2 * margin;
  // Whole pixels per module at the displayed size avoid platform-dependent
  // rounding at square edges. Include exactly the four-module quiet zone;
  // fit the available panel width without adding another white frame.
  const scale = Math.max(1, Math.floor(availablePixels / side));
  const pixels = side * scale;
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
      path += `M${start + margin} ${y + margin}h${x - start}v1H${start + margin}z`;
    }
  }
  // Only reviewed, bundled 32 × 32 vector logos are passed here. A small
  // nine-module white backing keeps the logo legible; level H provides repair
  // capacity. Browser tests decode the final rendered image, including the logo.
  const logoSize = 7;
  const offset = (side - logoSize) / 2;
  const artwork = logo.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" viewBox="0 0 ${pixels} ${pixels}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><g transform="scale(${scale})"><path d="${path}" fill="black"/><rect x="${offset - 1}" y="${offset - 1}" width="9" height="9" fill="white"/><g transform="translate(${offset} ${offset}) scale(${logoSize / 32})" shape-rendering="geometricPrecision">${artwork}</g></g></svg>`;
  return { src: `data:image/svg+xml;base64,${btoa(svg)}`, pixels };
}
