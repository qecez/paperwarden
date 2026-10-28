import { readFile, readdir } from "node:fs/promises";
export async function notices() {
  let text = "Paperwarden\n" + (await readFile("LICENSE", "utf8"));
  for (const file of [
    "hat.sh-MIT.txt",
    "Roboto-Apache-2.0.txt",
    "BIP39-English-MIT.txt",
    "Octicons-MIT.txt",
  ])
    text +=
      `\n\n=== ${file} ===\n` +
      (await readFile(`docs/licenses/${file}`, "utf8"));
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  for (const [path, pkg] of Object.entries(lock.packages).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (!path.startsWith("node_modules/") || pkg.dev) continue;
    text += `\n\n=== ${path.slice(13)} ${pkg.version} (${pkg.license ?? "see license"}) ===\n`;
    for (const file of (await readdir(path)).sort())
      if (/^(license|licence|copying|notice)(\.|$)/i.test(file))
        text += (await readFile(`${path}/${file}`, "utf8")) + "\n";
  }
  return text;
}
