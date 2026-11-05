import { readFile, readdir } from "node:fs/promises";

const mitTerms = /Permission is hereby granted[\s\S]*?SOFTWARE\./;
const apacheTerms =
  /[ \t]*Apache License\n[\s\S]*?limitations under the License\./;
const normalized = (text) => text.replace(/\s+/g, " ").trim();

/** Only dependencies that contribute bytes belong in a standalone reader. */
export function bundledPackages(metafiles) {
  const packages = new Map();
  for (const metadata of metafiles)
    for (const output of Object.values(metadata.outputs))
      for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
        if (!bytesInOutput) continue;
        const parts = input.split("/");
        const index = parts.lastIndexOf("node_modules");
        if (index < 0) continue;
        const count = parts[index + 1].startsWith("@") ? 3 : 2;
        const directory = parts.slice(0, index + count).join("/");
        if (!packages.has(directory)) packages.set(directory, new Set());
        packages.get(directory).add(input);
      }
  return new Map(
    [...packages].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** Preserve attribution and terms, with shared license text included once. */
export async function notices(metafiles) {
  const own = await readFile("LICENSE", "utf8");
  const thirdParty = await readFile("docs/THIRD_PARTY_NOTICES.txt", "utf8");
  const mit = own.match(mitTerms)?.[0];
  const apache = thirdParty.match(apacheTerms)?.[0];
  if (!mit || !apache) throw new Error("Missing shared license terms");
  let apacheIncluded = false;
  const compact = (text) => {
    text = text.replace(mitTerms, (terms) =>
      normalized(terms) === normalized(mit)
        ? "MIT license terms above apply."
        : terms,
    );
    text = text.replace(apacheTerms, (terms) => {
      if (terms !== apache) return terms;
      if (apacheIncluded) return "Apache License 2.0 terms above apply.";
      apacheIncluded = true;
      return terms;
    });
    return text
      .replace(/^={3,}\s*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  };
  const sections = ["Paperwarden\n\n" + own.trim(), compact(thirdParty)];
  for (const [directory, inputs] of bundledPackages(metafiles)) {
    const pkg = JSON.parse(await readFile(`${directory}/package.json`, "utf8"));
    const files = (await readdir(directory, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() &&
          /^(license|licence|copying|notice)(\.|$)/i.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
    if (!files.length) throw new Error(`Missing license for ${pkg.name}`);
    const texts = await Promise.all(
      files.map((file) => readFile(`${directory}/${file}`, "utf8")),
    );
    // ZXing's plain source headers are discarded by the JS bundler. Preserve
    // their copyright lines alongside its complete package license.
    if (pkg.name === "@zxing/library") {
      const copyrights = new Set();
      for (const input of [...inputs].sort()) {
        const source = await readFile(input, "utf8");
        for (const line of source.matchAll(/^\s*\*\s*(Copyright[^\r\n]*)/gm))
          copyrights.add(line[1].trim());
      }
      texts.unshift([...copyrights].sort().join("\n"));
    }
    if (pkg.name === "hash-wasm") {
      // Argon2's BLAKE2b WASM carries a separate, explicitly selected CC0
      // license. The JS compiler helper also has its own source notice.
      const blake = await readFile(`${directory}/src/blake2b.c`, "utf8");
      const copyright = blake.match(/Copyright[^\r\n]+/);
      if (!copyright || !blake.includes("CC0"))
        throw new Error("Missing BLAKE2b attribution");
      texts.push(
        `BLAKE2b reference implementation\n${copyright[0].replace(/\.\s+You may.*$/, ".")}\nModified for hash-wasm by Dani Biró.\nUsed under the CC0 1.0 option; full terms above.`,
      );
      for (const input of [...inputs].sort()) {
        const source = await readFile(input, "utf8");
        for (const [comment] of source.matchAll(/\/\*[\s\S]*?\*\//g))
          if (comment.includes("Copyright (c) Microsoft Corporation."))
            texts.push(
              comment
                .replace(/^\/\*+\s*/, "")
                .replace(/\*+\s*\/$/, "")
                .trim(),
            );
      }
    }
    sections.push(
      `${pkg.name} ${pkg.version}\n\n${compact(texts.join("\n\n"))}`,
    );
  }
  return sections.join("\n\n") + "\n";
}
