import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parse, serialize } from "parse5";
import { notices } from "./notices.mjs";
const options = {
  bundle: true,
  write: false,
  platform: "browser",
  target: "es2022",
  format: "iife",
  minify: false,
  legalComments: "inline",
  charset: "utf8",
};
const [app, worker] = await Promise.all([
  build({ ...options, entryPoints: ["src/main.ts"] }),
  build({ ...options, entryPoints: ["src/crypto/worker.ts"] }),
]);
const escapeScript = (text) => text.replace(/<\/script/gi, "<\\/script");
const code = escapeScript(app.outputFiles[0].text);
let css = await readFile("src/app/style.css", "utf8");
for (const font of ["roboto-regular.woff2", "roboto-bold.woff2"])
  css = css.replace(
    `url("./fonts/${font}")`,
    `url("data:font/woff2;base64,${(await readFile(`src/app/fonts/${font}`)).toString("base64")}")`,
  );
const metadata = JSON.parse(await readFile("package.json", "utf8"));
let html = (await readFile("index.html", "utf8"))
  .replace(
    /<link\s+rel="stylesheet"\s+href="\/src\/app\/style.css"\s*\/?>/,
    () => `<style>${css}</style>`,
  )
  .replaceAll("__APP_VERSION__", metadata.version.replace(/\.0$/, ""))
  .replace("__WORKER_SOURCE__", () => escapeScript(worker.outputFiles[0].text))
  .replace(
    /<script\s+id="application"\s+type="module"\s+src="\/src\/main.ts"\s*>\s*<\/script>/,
    () => `<script id="application" type="module">${code}</script>`,
  );
for (const name of ["paperwarden-icon", "paperwarden-logo"])
  html = html.replaceAll(
    `/src/app/assets/${name}.svg`,
    `data:image/svg+xml;base64,${(await readFile(`src/app/assets/${name}.svg`)).toString("base64")}`,
  );
const hash = (text) =>
  `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
const csp = `default-src 'none'; script-src ${hash(code)} 'wasm-unsafe-eval'; style-src ${hash(css)}; font-src data:; img-src data: blob:; media-src blob:; worker-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'`;
html = html.replace(
  "<head>",
  () => `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`,
);
const licenses = escapeScript(await notices());
html = html.replace(
  "</body>",
  () => `<script id="licenses" type="text/plain">${licenses}</script></body>`,
);
// Save offline reader uses this same canonical serialization before any UI mutation.
html = serialize(parse(html));
if (/__APP_VERSION__|__WORKER_SOURCE__|src="\/src\//.test(html))
  throw new Error("Unresolved build input");
await mkdir("dist", { recursive: true });
await writeFile("dist/paperwarden.html", html);
await writeFile(
  "dist/paperwarden.html.sha256",
  `${createHash("sha256").update(html).digest("hex")}  paperwarden.html\n`,
);
console.log(
  `Built self-contained paperwarden.html (${Buffer.byteLength(html).toLocaleString()} bytes).`,
);
