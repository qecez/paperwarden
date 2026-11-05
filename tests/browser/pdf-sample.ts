import { build } from "esbuild";
import { resolve } from "node:path";

/** A separate, public-fixture test page; never included in the reader build. */
export async function pdfSample(): Promise<string> {
  const result = await build({
    stdin: {
      contents: `
        import { preparePrint } from './src/print/backup';
        import { download } from './src/recovery/download';
        import fixture from './tests/fixtures/reference.json';
        const bytes = Uint8Array.from(fixture.hex.match(/../g), c => parseInt(c, 16));
        const prepared = await preparePrint(bytes);
        for (const size of ['A4', 'Letter']) {
          document.getElementById(size).onclick = () => download(
            prepared.pdfs[size], 'application/pdf', 'paperwarden-public-test-' + size.toLowerCase() + '.pdf'
          );
        }
        document.getElementById('status').textContent = 'Ready';
      `,
      resolveDir: resolve("."),
    },
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
  });
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paperwarden public PDF test</title><style>body{font:18px system-ui;max-width:42rem;margin:2rem auto;padding:1rem}button{font:inherit;padding:1rem;margin:.5rem}code{overflow-wrap:anywhere}</style><h1>Paperwarden PDF test</h1><p>This is a public test backup. It contains no secrets. These buttons generate the PDF on this device.</p><p>Save both files, reopen them in Files, and share/reopen one. Each must have four pages. Print page one at 100% and recover it with Paperwarden.</p><p>Test password: <code>another separate test password</code></p><p>Expected message: “A separate message.” followed by “保持”.</p><button id="A4">Save A4 PDF</button><button id="Letter">Save Letter PDF</button><p id="status">Preparing…</p><script type="module">${result.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></html>`;
}

/** Bundle the same source for the Node-side byte comparison (no PDF fixture regeneration). */
export async function nodePreparer(): Promise<
  typeof import("../../src/print/backup")
> {
  const result = await build({
    entryPoints: ["src/print/backup.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  });
  return import(
    "data:text/javascript;base64," +
      Buffer.from(result.outputFiles[0].contents).toString("base64")
  );
}
