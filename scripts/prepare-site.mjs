import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

const repository = "https://github.com/qecez/paperwarden";
const git = (...args) =>
  execFileSync("git", args, { maxBuffer: 16 * 1024 * 1024 });
const head = git("rev-parse", "HEAD").toString().trim();
const commit = process.env.GITHUB_SHA ?? head;
if (!/^[0-9a-f]{40}$/.test(commit) || commit !== head)
  throw new Error(
    "Prepare the checked-out commit; GITHUB_SHA must match HEAD.",
  );
if (git("status", "--porcelain", "--untracked-files=no").length)
  throw new Error("Commit tracked changes before preparing a deployment.");

const files = {};
for (const name of [
  "paperwarden.html",
  "paperwarden.html.sha256",
  "PWN-1.md",
  "PWN-1.md.sha256",
]) {
  const bytes = await readFile(`dist/${name}`);
  if (!bytes.equals(git("show", `${commit}:dist/${name}`)))
    throw new Error(`${name} must exactly match the source commit.`);
  files[name] = bytes;
}
if (!files["PWN-1.md"].equals(git("show", `${commit}:docs/FORMAT.md`)))
  throw new Error("The released specification must match docs/FORMAT.md.");
function checkedDigest(name) {
  const digest = createHash("sha256").update(files[name]).digest("hex");
  if (files[`${name}.sha256`].toString() !== `${digest}  ${name}\n`)
    throw new Error(
      `The committed checksum for ${name} does not match its bytes.`,
    );
  return digest;
}
const readerSha256 = checkedDigest("paperwarden.html");
const specSha256 = checkedDigest("PWN-1.md");
const manifest = {
  schemaVersion: 2,
  repository,
  commit,
  readerSourceCommit: commit,
  format: "PWN-1",
  readerSha256,
  specSha256,
  release: `${repository}/releases/tag/sha256-${readerSha256}`,
  sourceCommit: `${repository}/commit/${commit}`,
};
if (process.env.GITHUB_RUN_ID) {
  if (
    process.env.GITHUB_REPOSITORY !== "qecez/paperwarden" ||
    !/^\d+$/.test(process.env.GITHUB_RUN_ID)
  )
    throw new Error("Unexpected GitHub workflow identity.");
  manifest.workflowRun = `${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`;
}

// Provenance is detached: hosted and saved readers have exactly the same bytes.
const directory = "artifacts/site";
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
await Promise.all([
  ...Object.entries(files).map(([name, bytes]) =>
    writeFile(`${directory}/${name}`, bytes),
  ),
  writeFile(`${directory}/index.html`, files["paperwarden.html"]),
  writeFile(
    `${directory}/deployment.json`,
    JSON.stringify(manifest, null, 2) + "\n",
  ),
  writeFile(`${directory}/_redirects`, "/ /index.html 200\n"),
  writeFile(
    `${directory}/_headers`,
    "/*\n" +
      "  Cache-Control: no-store, no-transform\n" +
      "  X-Content-Type-Options: nosniff\n" +
      "  Referrer-Policy: no-referrer\n" +
      "  X-Frame-Options: DENY\n" +
      "  Content-Security-Policy: frame-ancestors 'none'\n" +
      "/paperwarden.html.sha256\n" +
      "  Content-Type: text/plain; charset=utf-8\n" +
      "/PWN-1.md\n" +
      "  Content-Type: text/plain; charset=utf-8\n" +
      "/PWN-1.md.sha256\n" +
      "  Content-Type: text/plain; charset=utf-8\n",
  ),
]);
console.log(`Prepared ${directory} from ${commit}; SHA-256 ${readerSha256}.`);
