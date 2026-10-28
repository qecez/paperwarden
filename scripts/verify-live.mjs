import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

const repository = "https://github.com/qecez/paperwarden";
let base = "https://paperwarden.com/";
let commit;
let attempts = 1;
let hasBase = false;
const args = process.argv.slice(2);
while (args.length) {
  const arg = args.shift();
  if (arg === "--commit") {
    commit = args.shift();
    if (!commit) throw new Error("--commit requires a full source commit.");
  } else if (arg === "--attempts") attempts = Number(args.shift());
  else if (!arg.startsWith("-") && !hasBase) {
    base = arg;
    hasBase = true;
  } else throw new Error(`Unknown option: ${arg}`);
}
if (!Number.isInteger(attempts) || attempts < 1 || attempts > 12)
  throw new Error("--attempts must be an integer from 1 to 12.");
const git = (...values) =>
  execFileSync("git", values, { maxBuffer: 16 * 1024 * 1024 });
commit ??= git("rev-parse", "HEAD").toString().trim();
if (!/^[0-9a-f]{40}$/.test(commit))
  throw new Error("Choose a trusted full 40-character source commit.");
const expected = git("show", `${commit}:dist/paperwarden.html`);
const checksum = git("show", `${commit}:dist/paperwarden.html.sha256`);
const digest = createHash("sha256").update(expected).digest("hex");
if (checksum.toString() !== `${digest}  paperwarden.html\n`)
  throw new Error("The trusted commit's checksum does not match its reader.");
const url = new URL(base);
const localHttp =
  url.protocol === "http:" &&
  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
if (
  (url.protocol !== "https:" && !localHttp) ||
  url.username ||
  url.password ||
  url.pathname !== "/" ||
  url.search ||
  url.hash
)
  throw new Error("Use an HTTPS origin without a path, query, or fragment.");

async function fetchBytes(path, limit, type) {
  const response = await fetch(new URL(path, url), {
    redirect: "error",
    cache: "no-store",
    headers: { "Cache-Control": "no-cache", Accept: type },
    signal: globalThis.AbortSignal.timeout(15000),
  });
  if (response.status !== 200)
    throw new Error(`${path} returned HTTP ${response.status}.`);
  if (!response.headers.get("content-type")?.startsWith(type))
    throw new Error(`${path} has an unexpected content type.`);
  for (const [name, value] of [
    ["x-content-type-options", "nosniff"],
    ["referrer-policy", "no-referrer"],
    ["x-frame-options", "DENY"],
    ["content-security-policy", "frame-ancestors 'none'"],
  ]) {
    if (response.headers.get(name) !== value)
      throw new Error(`${path} has an unexpected ${name} header.`);
  }
  const cache = response.headers.get("cache-control")?.split(/\s*,\s*/);
  if (!cache?.includes("no-store") || !cache.includes("no-transform"))
    throw new Error(
      `${path} must disable caching and content transformations.`,
    );
  if (Number(response.headers.get("content-length")) > limit || !response.body)
    throw new Error(`${path} has an invalid response size.`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`${path} exceeds the permitted response size.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

async function verify() {
  const [root, download, liveChecksum, rawManifest] = await Promise.all([
    fetchBytes("/", expected.length, "text/html"),
    fetchBytes("/paperwarden.html", expected.length, "text/html"),
    fetchBytes("/paperwarden.html.sha256", 256, "text/plain"),
    fetchBytes("/deployment.json", 16384, "application/json"),
  ]);
  if (!root.equals(expected) || !download.equals(expected))
    throw new Error("The live reader differs from the trusted source commit.");
  if (!liveChecksum.equals(checksum))
    throw new Error(
      "The live checksum differs from the trusted source commit.",
    );
  const manifest = JSON.parse(rawManifest.toString());
  if (
    manifest.schemaVersion !== 1 ||
    manifest.repository !== repository ||
    manifest.commit !== commit ||
    manifest.readerSha256 !== digest ||
    manifest.sourceCommit !== `${repository}/commit/${commit}` ||
    (manifest.workflowRun !== undefined &&
      !/^https:\/\/github\.com\/qecez\/paperwarden\/actions\/runs\/\d+$/.test(
        manifest.workflowRun,
      ))
  )
    throw new Error(
      "The deployment manifest does not match the trusted commit.",
    );
}

for (let attempt = 1; attempt <= attempts; attempt++) {
  try {
    await verify();
    console.log(`Verified ${url.origin} against ${commit}; SHA-256 ${digest}.`);
    break;
  } catch (error) {
    if (attempt === attempts) throw error;
    console.error(`Verification attempt ${attempt} failed: ${error.message}`);
    await wait(5000);
  }
}
