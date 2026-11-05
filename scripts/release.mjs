import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseNotes, releasePlan } from "./release-plan.mjs";

const repository = "qecez/paperwarden";
const repositoryUrl = `https://github.com/${repository}`;
const mode = process.argv[2];
if (!["--check", "--publish"].includes(mode) || process.argv.length !== 3)
  throw new Error(
    "Use --check to prepare provenance or --publish before deployment.",
  );
const git = (...args) =>
  execFileSync("git", args, { maxBuffer: 16 * 1024 * 1024 });
const gh = (...args) =>
  execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });
function api(path) {
  try {
    return JSON.parse(gh("api", `repos/${repository}/${path}`));
  } catch (error) {
    if (/\(HTTP 404\)/.test(String(error.stderr))) return null;
    throw error;
  }
}
const commit = git("rev-parse", "HEAD").toString().trim();
if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit)
  throw new Error("Release the verified checkout only.");
const files = [
  "paperwarden.html",
  "paperwarden.html.sha256",
  "PWN-1.md",
  "PWN-1.md.sha256",
];
const local = new Map();
for (const file of files) {
  const bytes = await readFile(`artifacts/site/${file}`);
  if (!bytes.equals(git("show", `${commit}:dist/${file}`)))
    throw new Error(`Prepared ${file} differs from the verified commit.`);
  local.set(file, bytes);
}
if (!local.get("PWN-1.md").equals(git("show", `${commit}:docs/FORMAT.md`)))
  throw new Error("The released specification must match docs/FORMAT.md.");
const digest = (name) =>
  createHash("sha256").update(local.get(name)).digest("hex");
const readerSha256 = digest("paperwarden.html");
const specSha256 = digest("PWN-1.md");
for (const [file, hash] of [
  ["paperwarden.html", readerSha256],
  ["PWN-1.md", specSha256],
])
  if (local.get(`${file}.sha256`).toString() !== `${hash}  ${file}\n`)
    throw new Error(`Prepared checksum for ${file} differs from its bytes.`);
const { tag } = releasePlan(readerSha256, commit);
const manifest = JSON.parse(
  await readFile("artifacts/site/deployment.json", "utf8"),
);
const sharedIdentity = {
  schemaVersion: 2,
  repository: repositoryUrl,
  format: "PWN-1",
  readerSha256,
  specSha256,
  release: `${repositoryUrl}/releases/tag/${tag}`,
};
function checkManifest(record, source, readerSource = source) {
  for (const [field, value] of Object.entries({
    ...sharedIdentity,
    commit: source,
    readerSourceCommit: readerSource,
    sourceCommit: `${repositoryUrl}/commit/${source}`,
  }))
    if (record[field] !== value)
      throw new Error(`Deployment ${field} differs.`);
  if (
    record.workflowRun !== undefined &&
    !/^https:\/\/github\.com\/qecez\/paperwarden\/actions\/runs\/\d+$/.test(
      record.workflowRun,
    )
  )
    throw new Error("Unexpected deployment workflow identity.");
}
function tagTarget() {
  let object = api(`git/ref/tags/${tag}`)?.object;
  for (let depth = 0; object?.type === "tag" && depth < 4; depth++)
    object = api(`git/tags/${object.sha}`)?.object;
  if (object && object.type !== "commit")
    throw new Error("Unresolved release tag.");
  return object?.sha ?? null;
}
const taggedCommit = tagTarget();
const plan = releasePlan(readerSha256, commit, taggedCommit);
// The reader release retains its original source. Deployment provenance records
// the current verified commit, including hosting and security-header changes.
if (mode === "--check") manifest.readerSourceCommit = plan.sourceCommit;
checkManifest(manifest, commit, plan.sourceCommit);
function checkTaggedSource() {
  const source = api(`git/commits/${plan.sourceCommit}`);
  if (
    source?.sha !== plan.sourceCommit ||
    !/^[0-9a-f]{40}$/.test(source?.tree?.sha)
  )
    throw new Error("The release source commit could not be verified.");
  const tree = api(`git/trees/${source.tree.sha}?recursive=1`);
  if (!tree || tree.truncated || !Array.isArray(tree.tree))
    throw new Error("The complete release source tree is required.");
  for (const [path, bytes] of [
    ...files.map((file) => [`dist/${file}`, local.get(file)]),
    ["docs/FORMAT.md", local.get("PWN-1.md")],
  ]) {
    const entry = tree.tree.find((item) => item.path === path);
    const blob = createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (entry?.type !== "blob" || entry.mode !== "100644" || entry.sha !== blob)
      throw new Error(
        `The release source ${path} differs from the prepared artifact.`,
      );
  }
}
function findRelease() {
  let record;
  try {
    // REST's by-tag endpoint omits drafts. gh resolves draft tags through
    // GraphQL so an interrupted publication can resume the same release.
    record = JSON.parse(
      gh("release", "view", tag, "--repo", repository, "--json", "databaseId"),
    );
  } catch (error) {
    if (/release not found|\(HTTP 404\)/i.test(String(error.stderr)))
      return null;
    throw error;
  }
  if (!Number.isSafeInteger(record.databaseId) || record.databaseId <= 0)
    throw new Error("The release identifier could not be verified.");
  const release = api(`releases/${record.databaseId}`);
  if (!release) throw new Error("The resolved release could not be loaded.");
  return release;
}
let release = findRelease();
if (release && !release.draft && !taggedCommit)
  throw new Error("A published release requires its source tag.");
if (release?.draft && release.target_commitish !== commit)
  throw new Error("The existing draft is not for this verified commit.");
if (release && !release.draft && release.immutable !== true)
  throw new Error("The existing release is not natively immutable.");
if (!release && taggedCommit && taggedCommit !== commit)
  throw new Error("An unpublished tag points at another source commit.");
const newRelease = release === null || release.draft;
let changes;
if (newRelease) {
  let changelog;
  try {
    changelog = git("show", `${commit}:CHANGELOG.md`).toString("utf8");
  } catch {
    throw new Error("New reader releases require a committed CHANGELOG.md.");
  }
  changes = releaseNotes(changelog, tag);
}
if (mode === "--publish" && !release) {
  const directory = await mkdtemp(join(tmpdir(), "paperwarden-release-notes-"));
  try {
    const notes = join(directory, "notes.md");
    await writeFile(
      notes,
      `${changes}\n\n` +
        `Source: [${commit}](${repositoryUrl}/commit/${commit}). ` +
        `See [verification instructions](${repositoryUrl}/blob/${commit}/docs/HOSTING.md) ` +
        `for reproducible builds and signed GitHub provenance.\n\n` +
        `SHA-256 checksums:\n\n\`\`\`text\n` +
        local.get("paperwarden.html.sha256").toString() +
        local.get("PWN-1.md.sha256").toString() +
        `\`\`\`\n`,
    );
    gh(
      "release",
      "create",
      tag,
      "--draft",
      ...files.map((file) => `artifacts/site/${file}`),
      "artifacts/site/deployment.json",
      "--repo",
      repository,
      "--target",
      commit,
      "--title",
      `Paperwarden · ${readerSha256.slice(0, 12)}`,
      "--notes-file",
      notes,
      ...(taggedCommit ? ["--verify-tag"] : []),
    );
    release = findRelease();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function checkReleaseAssets(record) {
  checkTaggedSource();
  if (
    record.prerelease ||
    record.tag_name !== tag ||
    record.target_commitish !== plan.sourceCommit ||
    (!record.draft && record.immutable !== true) ||
    !Array.isArray(record.assets) ||
    record.assets.length !== files.length + 1 ||
    new Set(record.assets.map((asset) => asset.name)).size !==
      files.length + 1 ||
    record.assets.some(
      (asset) =>
        ![...files, "deployment.json"].includes(asset.name) ||
        asset.state !== "uploaded",
    )
  )
    throw new Error("The release must contain exactly the verified assets.");
  const directory = await mkdtemp(join(tmpdir(), "paperwarden-release-check-"));
  try {
    gh(
      "release",
      "download",
      tag,
      "--repo",
      repository,
      "--dir",
      directory,
      ...[...files, "deployment.json"].flatMap((file) => ["--pattern", file]),
    );
    for (const file of [...files, "deployment.json"]) {
      const bytes = await readFile(join(directory, file));
      const asset = record.assets.find((item) => item.name === file);
      if (
        asset.size !== bytes.length ||
        asset.digest !==
          `sha256:${createHash("sha256").update(bytes).digest("hex")}`
      )
        throw new Error(`Release metadata differs from downloaded ${file}.`);
      if (file !== "deployment.json" && !bytes.equals(local.get(file)))
        throw new Error(
          `Published ${file} differs; never overwrite release assets.`,
        );
      if (file === "deployment.json") {
        const published = JSON.parse(bytes.toString());
        checkManifest(published, plan.sourceCommit);
        // A draft has not yet established a release identity. It must contain
        // this run's exact attested manifest before it can be published.
        if (
          record.draft &&
          !bytes.equals(await readFile("artifacts/site/deployment.json"))
        )
          throw new Error(
            "Draft provenance differs; review the incomplete draft.",
          );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (release) await checkReleaseAssets(release);
if (mode === "--publish") {
  if (!release) throw new Error("The verified release was not created.");
  if (release.draft) {
    gh("release", "edit", tag, "--repo", repository, "--draft=false");
    release = findRelease();
  }
  if (
    !release ||
    release.draft ||
    release.immutable !== true ||
    tagTarget() !== plan.sourceCommit
  )
    throw new Error(
      "The published immutable release must identify the verified source commit.",
    );
  await checkReleaseAssets(release);
  gh("release", "verify", tag, "--repo", repository);
}
if (mode === "--check") {
  await writeFile(
    "artifacts/site/deployment.json",
    JSON.stringify(manifest, null, 2) + "\n",
  );
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `tag=${tag}\nreader_sha256=${readerSha256}\nnew_release=${newRelease}\nreader_source_commit=${plan.sourceCommit}\n`,
    );
}
console.log(
  `${tag}: ${release ? "published files verified; existing release retained" : "new reader ready for publication"}.`,
);
