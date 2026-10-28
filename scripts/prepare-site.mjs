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

const reader = await readFile("dist/paperwarden.html");
const checksum = await readFile("dist/paperwarden.html.sha256");
if (
  !reader.equals(git("show", `${commit}:dist/paperwarden.html`)) ||
  !checksum.equals(git("show", `${commit}:dist/paperwarden.html.sha256`))
)
  throw new Error(
    "The reader and checksum must exactly match the source commit.",
  );
const readerSha256 = createHash("sha256").update(reader).digest("hex");
if (checksum.toString() !== `${readerSha256}  paperwarden.html\n`)
  throw new Error("The committed reader checksum does not match its bytes.");

const manifest = {
  schemaVersion: 1,
  repository,
  commit,
  readerSha256,
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

// Deployment metadata stays outside the reader: its exact bytes remain portable.
const directory = "artifacts/site";
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
await Promise.all([
  writeFile(`${directory}/index.html`, reader),
  writeFile(`${directory}/paperwarden.html`, reader),
  writeFile(`${directory}/paperwarden.html.sha256`, checksum),
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
      "  Content-Type: text/plain; charset=utf-8\n",
  ),
]);
console.log(`Prepared ${directory} from ${commit}; SHA-256 ${readerSha256}.`);
