import { afterEach, beforeEach, expect, test } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const workflow = await readFile(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
// Exercise the exact built-in-only verifier executed by the fresh deployment
// runner. Downloaded assets are data; no release-provided program is executed.
const verifier = workflow
  .match(/<<'VERIFY_RELEASE'\n([\s\S]*?)\n\s*VERIFY_RELEASE\n/)![1]
  .split("\n")
  .map((line) => line.replace(/^ {10}/, ""))
  .join("\n");
const prepare = fileURLToPath(
  new URL("../scripts/prepare-site.mjs", import.meta.url),
);
const repo = "https://github.com/qecez/paperwarden";
const hash = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const reader = Buffer.from(
  "<!DOCTYPE html><title>Public verified fixture</title>",
);
const spec = Buffer.from("# PWN-1\nPublic fixture specification.\n");
const digest = hash(reader);
const tag = `sha256-${digest}`;
let directory: string;
let source: string;
let environment: NodeJS.ProcessEnv;
type Asset = { name: string; state: string; size: number; digest: string };
type Release = {
  immutable: boolean;
  draft: boolean;
  prerelease: boolean;
  tag_name: string;
  target_commitish: string;
  assets: Asset[];
};
let metadata: Release;
const invoke = () =>
  run(process.execPath, ["--input-type=module", "-e", verifier], {
    cwd: directory,
    env: environment,
  });
const saveMetadata = () =>
  writeFile(join(directory, "release.json"), JSON.stringify(metadata));
async function replaceAsset(
  name: string,
  bytes: Buffer | string,
  committed = false,
) {
  await writeFile(join(directory, "release", name), bytes);
  const asset = metadata.assets.find((asset) => asset.name === name)!;
  asset.size = Buffer.byteLength(bytes);
  asset.digest = `sha256:${hash(bytes)}`;
  if (committed) await writeFile(join(directory, "dist", name), bytes);
  await saveMetadata();
}
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: directory });
const commit = () => {
  git("add", "dist", "docs");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "Fixture",
  );
  return git("rev-parse", "HEAD").toString().trim();
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "paperwarden-release-deploy-"));
  for (const folder of ["dist", "docs", "release", "deployment"])
    await mkdir(join(directory, folder));
  const files: Record<string, Buffer | string> = {
    "paperwarden.html": reader,
    "paperwarden.html.sha256": `${digest}  paperwarden.html\n`,
    "PWN-1.md": spec,
    "PWN-1.md.sha256": `${hash(spec)}  PWN-1.md\n`,
  };
  for (const [name, bytes] of Object.entries(files))
    await writeFile(join(directory, "dist", name), bytes);
  await writeFile(join(directory, "docs/FORMAT.md"), spec);
  git("init", "--quiet");
  source = commit();
  environment = {
    ...process.env,
    GITHUB_SHA: source,
    GITHUB_RUN_ID: "1234",
    GITHUB_REPOSITORY: "qecez/paperwarden",
    READER_SOURCE_COMMIT: source,
    READER_SHA256: digest,
    RELEASE_TAG: tag,
  };
  await run(process.execPath, [prepare], { cwd: directory, env: environment });
  files["deployment.json"] = await readFile(
    join(directory, "artifacts/site/deployment.json"),
  );
  metadata = {
    immutable: true,
    draft: false,
    prerelease: false,
    tag_name: tag,
    target_commitish: source,
    assets: Object.entries(files).map(([name, value]) => ({
      name,
      state: "uploaded",
      size: Buffer.byteLength(value),
      digest: `sha256:${hash(value)}`,
    })),
  };
  for (const [name, bytes] of Object.entries(files))
    await writeFile(join(directory, "release", name), bytes);
  await saveMetadata();
});
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("deploys the exact released bytes and attested deployment record without executing release code", async () => {
  await invoke();
  for (const name of [
    "index.html",
    "paperwarden.html",
    "paperwarden.html.sha256",
    "PWN-1.md",
    "PWN-1.md.sha256",
    "deployment.json",
    "_headers",
    "_redirects",
  ])
    expect(await readFile(join(directory, "site", name))).toEqual(
      await readFile(join(directory, "artifacts/site", name)),
    );
  const config = JSON.parse(
    await readFile(join(directory, "deployment/runtime.json"), "utf8"),
  );
  expect(config).toEqual({
    name: "paperwarden",
    account_id: "d19a6f72cfd41bbb045dd2cc8625a87e",
    compatibility_date: "2026-10-27",
    workers_dev: false,
    preview_urls: false,
    assets: {
      directory: "../site",
      html_handling: "none",
      not_found_handling: "none",
    },
    observability: { enabled: false },
  });
});

test("keeps the original reader source while signing the current deployment independently", async () => {
  await writeFile(
    join(directory, "docs/hosting-note.txt"),
    "A hosting-only change.\n",
  );
  const current = commit();
  environment.GITHUB_SHA = current;
  environment.GITHUB_RUN_ID = "5678";
  await invoke();
  const published = JSON.parse(
    await readFile(join(directory, "release/deployment.json"), "utf8"),
  );
  const deployed = JSON.parse(
    await readFile(join(directory, "site/deployment.json"), "utf8"),
  );
  expect(published.commit).toBe(source);
  expect(published.workflowRun).toBe(`${repo}/actions/runs/1234`);
  expect(deployed).toEqual({
    ...published,
    commit: current,
    sourceCommit: `${repo}/commit/${current}`,
    workflowRun: `${repo}/actions/runs/5678`,
  });
  expect(deployed.readerSourceCommit).toBe(source);
});

test.each([
  "draft",
  "mutable",
  "prerelease",
  "extra asset",
  "duplicate asset",
  "wrong source",
  "wrong tag",
  "unfinished upload",
])("rejects %s release metadata", async (failure) => {
  if (failure === "draft") metadata.draft = true;
  if (failure === "mutable") metadata.immutable = false;
  if (failure === "prerelease") metadata.prerelease = true;
  if (failure === "extra asset")
    metadata.assets.push({ ...metadata.assets[0], name: "unexpected.js" });
  if (failure === "duplicate asset") metadata.assets[1] = metadata.assets[0];
  if (failure === "wrong source") metadata.target_commitish = "0".repeat(40);
  if (failure === "wrong tag") metadata.tag_name = "other";
  if (failure === "unfinished upload") metadata.assets[0].state = "new";
  await saveMetadata();
  await expect(invoke()).rejects.toThrow("exact published immutable release");
  await expect(
    readFile(join(directory, "deployment/runtime.json")),
  ).rejects.toThrow();
});

test("rejects modified downloaded bytes even when the attacker retains the expected metadata", async () => {
  await writeFile(join(directory, "release/paperwarden.html"), "tampered");
  await expect(invoke()).rejects.toThrow("Release asset identity differs");
});

test("rejects an internally consistent release that differs from the approved commit", async () => {
  await replaceAsset("paperwarden.html", "tampered");
  await expect(invoke()).rejects.toThrow(
    "Release differs from approved source",
  );
});

test("rejects wrong reader identity even when both release and checkout are changed", async () => {
  await replaceAsset("paperwarden.html", "tampered", true);
  await expect(invoke()).rejects.toThrow("Reader or specification differs");
});

test("rejects a specification that differs from the source documentation", async () => {
  await replaceAsset("PWN-1.md", "different", true);
  await expect(invoke()).rejects.toThrow("Reader or specification differs");
});

test("rejects noncanonical checksum sidecars", async () => {
  await replaceAsset(
    "paperwarden.html.sha256",
    `${digest}  other.html\n`,
    true,
  );
  await expect(invoke()).rejects.toThrow("Checksum sidecar differs");
});

test.each(["commit", "readerSourceCommit", "workflowRun", "unexpected"])(
  "rejects original release provenance with a forged %s",
  async (field) => {
    const manifest = JSON.parse(
      await readFile(join(directory, "release/deployment.json"), "utf8"),
    );
    manifest[field] =
      field === "workflowRun"
        ? "https://github.com/another/repo/actions/runs/1234"
        : "0".repeat(40);
    await replaceAsset("deployment.json", JSON.stringify(manifest));
    await expect(invoke()).rejects.toThrow(
      "Original release provenance differs",
    );
  },
);

test.each([
  "GITHUB_SHA",
  "GITHUB_RUN_ID",
  "READER_SOURCE_COMMIT",
  "READER_SHA256",
  "RELEASE_TAG",
])("rejects an invalid approved %s", async (field) => {
  environment[field] = "untrusted";
  await expect(invoke()).rejects.toThrow("Invalid approved release identity");
});

test("the credential-bearing job verifies exact source and workflow identities on a fresh runner", () => {
  const release = workflow.split("\n  release:\n")[1].split("\n  deploy:\n")[0];
  const deploy = workflow.split("\n  deploy:\n")[1].split("\n  mirror:\n")[0];
  const mirror = workflow.split("\n  mirror:\n")[1];
  expect(release).toContain("needs: verify");
  expect(release).toContain("environment: release");
  expect(release).not.toContain("secrets.");
  expect(release).not.toMatch(/\bnpm\b/);
  expect(deploy).toContain("needs: release");
  expect(deploy).toContain("runs-on: ubuntu-latest");
  expect(deploy).toContain("contents: read");
  expect(deploy).toContain("npm ci --prefix deployment --ignore-scripts");
  expect(deploy).not.toMatch(
    /node scripts\/|npm run|npx |id-token: write|attestations: write/,
  );
  expect(deploy.match(/secrets\./g)).toHaveLength(1);
  expect(deploy).toContain('gh release verify "$RELEASE_TAG"');
  expect(deploy).toContain('gh release verify-asset "$RELEASE_TAG" "$file"');
  const commands = deploy.replace(/\\\n\s*/g, "").replace(/\s+/g, " ");
  expect(deploy).toContain('ATTESTATION_COMMIT="$GITHUB_SHA"');
  expect(deploy).toContain(
    'if [ "$file" = "release/deployment.json" ]; then\n              ATTESTATION_COMMIT="$READER_SOURCE_COMMIT"',
  );
  for (const identity of ["$ATTESTATION_COMMIT", "$GITHUB_SHA"])
    expect(commands).toContain(
      `--source-ref refs/heads/main --source-digest "${identity}" --signer-digest "${identity}" --deny-self-hosted-runners`,
    );
  expect(
    deploy.match(
      /--cert-identity https:\/\/github\.com\/qecez\/paperwarden\/\.github\/workflows\/ci\.yml@refs\/heads\/main/g,
    ),
  ).toHaveLength(2);
  expect(deploy.indexOf("CLOUDFLARE_API_TOKEN")).toBeGreaterThan(
    deploy.indexOf("gh attestation verify site/deployment.json"),
  );
  expect(mirror).toContain("environment: mirror");
  expect(mirror).not.toContain("CLOUDFLARE_API_TOKEN");
});
