import { afterEach, beforeEach, expect, test } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const prepare = fileURLToPath(
  new URL("../scripts/prepare-site.mjs", import.meta.url),
);
const release = fileURLToPath(
  new URL("../scripts/release.mjs", import.meta.url),
);
const reader = Buffer.from(
  "<!DOCTYPE html><title>Public release fixture</title>",
);
const specification = Buffer.from("# PWN-1\nPublic specification fixture.\n");
const digest = createHash("sha256").update(reader).digest("hex");
const changes =
  "Print an encrypted backup and recover it with the saved app.\n\n" +
  "- Keep messages under separate passwords.\n- Compare the Backup ID before recovery.";
const changelog = (hash = digest, body = changes) =>
  `# Change log\n\n## [Initial release](https://github.com/qecez/paperwarden/releases/tag/sha256-${hash})\n\n${body}\n`;
let directory: string;
let commit: string;
let environment: NodeJS.ProcessEnv;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: directory });
const makeCommit = () => {
  git("add", "dist", "docs", "CHANGELOG.md");
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
const invoke = (script: string, args: string[] = []) =>
  run(process.execPath, [script, ...args], {
    cwd: directory,
    env: environment,
  });
async function saveSpecification(bytes: Buffer) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(directory, "docs/FORMAT.md"), bytes);
  await writeFile(join(directory, "dist/PWN-1.md"), bytes);
  await writeFile(
    join(directory, "dist/PWN-1.md.sha256"),
    `${hash}  PWN-1.md\n`,
  );
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "paperwarden-publication-"));
  for (const folder of ["bin", "docs", "dist", "published"])
    await mkdir(join(directory, folder));
  await writeFile(join(directory, "dist/paperwarden.html"), reader);
  await writeFile(
    join(directory, "dist/paperwarden.html.sha256"),
    `${digest}  paperwarden.html\n`,
  );
  await saveSpecification(specification);
  await writeFile(join(directory, "docs/HOSTING.md"), "Hosting fixture.\n");
  await writeFile(join(directory, "CHANGELOG.md"), changelog());
  git("init", "--quiet");
  commit = makeCommit();
  // Fake only the GitHub boundary. Production scripts, commit checks, assets,
  // and original-source verification run unchanged; no network is available.
  const fakeGh = join(directory, "bin/gh");
  await writeFile(
    fakeGh,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const args = process.argv.slice(2);
const statePath = "remote.json";
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath)) : null;
const out = value => process.stdout.write(JSON.stringify(value));
const git = (...values) => cp.execFileSync("git", values, { encoding: "utf8" }).trim();
const option = name => args[args.indexOf(name) + 1];
const missing = () => { process.stderr.write("Not Found (HTTP 404)"); process.exit(1); };
const metadata = () => ({
  draft: state.draft, immutable: state.immutable, prerelease: false,
  tag_name: state.tag, target_commitish: state.commit, body: state.body,
  assets: fs.readdirSync("published").map(name => {
    const bytes=fs.readFileSync(path.join("published",name));
    return {name,state:"uploaded",size:bytes.length,digest:"sha256:"+crypto.createHash("sha256").update(bytes).digest("hex")};
  }),
  ...state.metadata,
});
fs.appendFileSync("calls.log", JSON.stringify(args) + "\\n");
if (args[0] === "api") {
  const route = args[1].replace("repos/qecez/paperwarden/", "");
  if (route.startsWith("git/ref/tags/")) { if (!state || state.draft || route.slice(13)!==state.tag) missing(); out({object:{type:"commit",sha:state.commit}}); }
  else if (route.startsWith("releases/tags/")) { if (!state || state.draft || route.slice(14)!==state.tag) missing(); out(metadata()); }
  else if (route === "releases/42") { if (!state) missing(); out(metadata()); }
  else if (route.startsWith("git/commits/")) { const sha = route.slice(12); out({sha,tree:{sha:git("rev-parse",sha+"^{tree}")}}); }
  else if (route.startsWith("git/trees/")) {
    const sha = route.slice(10).split("?")[0];
    const tree = git("ls-tree","-r",sha).split("\\n").map(line => {
      const match = /^(\\d+) (\\w+) ([0-9a-f]+)\\t(.+)$/.exec(line);
      return {mode:match[1],type:match[2],sha:match[3],path:match[4]};
    });
    if (state?.tamperTree) tree.find(entry=>entry.path==="dist/paperwarden.html").sha="0".repeat(40);
    out({truncated:false,tree});
  } else throw new Error("Unexpected API route: " + route);
} else if (args[0] === "release" && args[1] === "view") {
  if (!state || args[2]!==state.tag) { process.stderr.write("release not found"); process.exit(1); }
  out({databaseId:42});
} else if (args[0] === "release" && args[1] === "create") {
  if (!args.includes("--draft")) throw new Error("Publish assets only to a draft.");
  for (const file of args.slice(3,args.indexOf("--repo")).filter(value=>value!=="--draft")) fs.copyFileSync(file,path.join("published",path.basename(file)));
  fs.writeFileSync(statePath,JSON.stringify({commit:option("--target"),tag:args[2],draft:true,immutable:false,body:fs.readFileSync(option("--notes-file"),"utf8")}));
} else if (args[0] === "release" && args[1] === "download") {
  const destination = option("--dir");
  for (let i=0;i<args.length;i++) if(args[i]==="--pattern") fs.copyFileSync(path.join("published",args[i+1]),path.join(destination,args[i+1]));
} else if (args[0] === "release" && args[1] === "edit") {
  if (!state.draft || !args.includes("--draft=false")) throw new Error("Only publish a draft.");
  if (fs.existsSync("fail-publish")) throw new Error("Simulated interrupted publication.");
  fs.writeFileSync(statePath,JSON.stringify({...state,draft:false,immutable:!fs.existsSync("immutable-disabled")}));
} else if (args[0] === "release" && args[1] === "verify") {
  if (state.draft || !state.immutable || fs.existsSync("fail-native-proof")) throw new Error("Native release proof failed.");
} else throw new Error("Unexpected gh call: " + args.join(" "));
`,
  );
  await chmod(fakeGh, 0o755);
  environment = {
    ...process.env,
    PATH: `${join(directory, "bin")}:${process.env.PATH}`,
    GH_TOKEN: "",
    GITHUB_SHA: undefined,
    GITHUB_RUN_ID: undefined,
    GITHUB_REPOSITORY: undefined,
    GITHUB_OUTPUT: join(directory, "outputs.txt"),
  };
  await invoke(prepare);
});
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("publishes committed release prose once and retains notes, assets, and provenance across retries and documentation or hosting changes", async () => {
  await writeFile(
    join(directory, "CHANGELOG.md"),
    "# Change log\n\nUncommitted notes must not ship.\n",
  );
  await invoke(release, ["--check"]);
  expect(await readFile(join(directory, "outputs.txt"), "utf8")).toContain(
    "new_release=true",
  );
  expect(await readFile(join(directory, "calls.log"), "utf8")).not.toContain(
    '"create"',
  );
  await invoke(release, ["--publish"]);
  const publishedNotes = JSON.parse(
    await readFile(join(directory, "remote.json"), "utf8"),
  ).body;
  expect(publishedNotes).toBe(
    `## Initial release\n\n${changes}\n\n` +
      `Source: [${commit}](https://github.com/qecez/paperwarden/commit/${commit}). ` +
      `See [verification instructions](https://github.com/qecez/paperwarden/blob/${commit}/docs/HOSTING.md) ` +
      `for reproducible builds and signed GitHub provenance.\n\n` +
      `SHA-256 checksums:\n\n\`\`\`text\n` +
      (await readFile(
        join(directory, "dist/paperwarden.html.sha256"),
        "utf8",
      )) +
      (await readFile(join(directory, "dist/PWN-1.md.sha256"), "utf8")) +
      `\`\`\`\n`,
  );
  expect(await readFile(join(directory, "published/paperwarden.html"))).toEqual(
    reader,
  );
  expect(await readFile(join(directory, "published/PWN-1.md"))).toEqual(
    specification,
  );
  const original = await readFile(join(directory, "published/deployment.json"));
  await writeFile(join(directory, "outputs.txt"), "");
  await invoke(release, ["--check"]);
  expect(await readFile(join(directory, "outputs.txt"), "utf8")).toContain(
    "new_release=false",
  );
  await invoke(release, ["--publish"]);
  // A documentation-only commit can omit the entry for an already published
  // reader. Publication must neither replace its prose nor demand a new entry.
  const documentation = makeCommit();
  expect(documentation).not.toBe(commit);
  await invoke(prepare);
  await invoke(release, ["--check"]);
  await invoke(release, ["--publish"]);
  expect(
    JSON.parse(await readFile(join(directory, "remote.json"), "utf8")).body,
  ).toBe(publishedNotes);
  await writeFile(
    join(directory, "docs/HOSTING.md"),
    "Updated hosting guidance.\n",
  );
  const later = makeCommit();
  expect(later).not.toBe(commit);
  await invoke(prepare);
  await writeFile(join(directory, "outputs.txt"), "");
  await invoke(release, ["--check"]);
  const outputs = await readFile(join(directory, "outputs.txt"), "utf8");
  expect(outputs).toContain("new_release=false");
  expect(outputs).toContain(`reader_source_commit=${commit}`);
  const prepared = JSON.parse(
    await readFile(join(directory, "artifacts/site/deployment.json"), "utf8"),
  );
  expect(prepared.commit).toBe(later);
  expect(prepared.readerSourceCommit).toBe(commit);
  await invoke(release, ["--publish"]);
  expect(await readFile(join(directory, "published/deployment.json"))).toEqual(
    original,
  );
  expect(
    JSON.parse(await readFile(join(directory, "remote.json"), "utf8")).body,
  ).toBe(publishedNotes);
  const calls = (await readFile(join(directory, "calls.log"), "utf8")).split(
    "\n",
  );
  expect(calls.filter((line) => line.includes('"create"'))).toHaveLength(1);
  expect(calls.filter((line) => line.includes('"edit"'))).toHaveLength(1);
  const firstPublish = calls.findIndex((line) => line.includes('"edit"'));
  expect(
    calls.slice(0, firstPublish).some((line) => line.includes('"download"')),
  ).toBe(true);
  expect(
    calls.slice(firstPublish).some((line) => line.includes('"verify"')),
  ).toBe(true);
});

test("resumes a complete draft after an interrupted publish without replacing its assets", async () => {
  await writeFile(join(directory, "fail-publish"), "");
  await expect(invoke(release, ["--publish"])).rejects.toThrow(
    "Simulated interrupted publication",
  );
  const draft = JSON.parse(
    await readFile(join(directory, "remote.json"), "utf8"),
  );
  expect(draft.draft).toBe(true);
  const original = await readFile(join(directory, "published/deployment.json"));
  await rm(join(directory, "fail-publish"));
  await invoke(release, ["--check"]);
  await invoke(release, ["--publish"]);
  expect(await readFile(join(directory, "published/deployment.json"))).toEqual(
    original,
  );
  expect(
    JSON.parse(await readFile(join(directory, "remote.json"), "utf8"))
      .immutable,
  ).toBe(true);
  const calls = await readFile(join(directory, "calls.log"), "utf8");
  expect(calls.match(/"create"/g)).toHaveLength(1);
});

test("does not publish incomplete or stale-provenance drafts", async () => {
  await writeFile(join(directory, "fail-publish"), "");
  await expect(invoke(release, ["--publish"])).rejects.toThrow();
  await rm(join(directory, "fail-publish"));
  await rm(join(directory, "published/paperwarden.html.sha256"));
  await expect(invoke(release, ["--publish"])).rejects.toThrow(
    "exactly the verified assets",
  );
  await writeFile(
    join(directory, "published/paperwarden.html.sha256"),
    `${digest}  paperwarden.html\n`,
  );
  const manifestPath = join(directory, "published/deployment.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(
    manifestPath,
    JSON.stringify({
      ...manifest,
      workflowRun: "https://github.com/qecez/paperwarden/actions/runs/999",
    }),
  );
  await expect(invoke(release, ["--publish"])).rejects.toThrow(
    "Draft provenance differs",
  );
  expect(
    JSON.parse(await readFile(join(directory, "remote.json"), "utf8")).draft,
  ).toBe(true);
});

test.each(["immutable-disabled", "fail-native-proof"])(
  "fails closed if %s",
  async (failure) => {
    await writeFile(join(directory, failure), "");
    await expect(invoke(release, ["--publish"])).rejects.toThrow(
      failure === "immutable-disabled"
        ? "published immutable release"
        : "Native release proof failed",
    );
  },
);

test.each([
  ["mutable", { immutable: false }, "not natively immutable"],
  ["prerelease", { prerelease: true }, "exactly the verified assets"],
  [
    "wrong target",
    { target_commitish: "0".repeat(40) },
    "exactly the verified assets",
  ],
  ["missing assets", { assets: [] }, "exactly the verified assets"],
])(
  "rejects %s published release metadata",
  async (_label, metadata, message) => {
    await invoke(release, ["--publish"]);
    const path = join(directory, "remote.json");
    const remote = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...remote, metadata }));
    await expect(invoke(release, ["--check"])).rejects.toThrow(
      message as string,
    );
  },
);

test.each([
  ["missing", changelog("a".repeat(64))],
  ["duplicate", changelog() + changelog()],
  [
    "empty",
    changelog(digest, " \n\t\n") + "\n## Other notes\nUnrelated prose.\n",
  ],
])(
  "rejects %s committed release prose before check or publication",
  async (_name, text) => {
    await writeFile(join(directory, "CHANGELOG.md"), text);
    makeCommit();
    await invoke(prepare);
    for (const mode of ["--check", "--publish"])
      await expect(invoke(release, [mode])).rejects.toThrow(
        "exactly one nonempty CHANGELOG.md entry",
      );
    const calls = (await readFile(join(directory, "calls.log"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.every((args) => args[0] === "api" || args[1] === "view")).toBe(
      true,
    );
    await expect(readFile(join(directory, "outputs.txt"))).rejects.toThrow();
    await expect(readFile(join(directory, "remote.json"))).rejects.toThrow();
  },
);

test("requires a committed changelog, even when an uncommitted copy exists", async () => {
  await rm(join(directory, "CHANGELOG.md"));
  makeCommit();
  await writeFile(join(directory, "CHANGELOG.md"), changelog());
  await invoke(prepare);
  await expect(invoke(release, ["--check"])).rejects.toThrow(
    "require a committed CHANGELOG.md",
  );
  expect(await readFile(join(directory, "calls.log"), "utf8")).not.toContain(
    '"create"',
  );
});

test("requires an entry for new reader bytes before allowing deployment", async () => {
  await invoke(release, ["--publish"]);
  const originalRelease = await readFile(join(directory, "remote.json"));
  const changed = Buffer.from(
    "<!DOCTYPE html><title>New public reader</title>",
  );
  const changedDigest = createHash("sha256").update(changed).digest("hex");
  await writeFile(join(directory, "dist/paperwarden.html"), changed);
  await writeFile(
    join(directory, "dist/paperwarden.html.sha256"),
    `${changedDigest}  paperwarden.html\n`,
  );
  makeCommit();
  await invoke(prepare);
  await expect(invoke(release, ["--check"])).rejects.toThrow(
    `entry linked to sha256-${changedDigest}`,
  );
  expect(await readFile(join(directory, "remote.json"))).toEqual(
    originalRelease,
  );
  expect(await readFile(join(directory, "published/paperwarden.html"))).toEqual(
    reader,
  );
});

test("rejects a changed specification under an existing reader identity", async () => {
  await invoke(release, ["--publish"]);
  await saveSpecification(Buffer.from("# PWN-1\nDifferent specification.\n"));
  makeCommit();
  await invoke(prepare);
  await expect(invoke(release, ["--check"])).rejects.toThrow(
    "release source dist/PWN-1.md differs",
  );
});

test("rejects changed prepared assets before contacting GitHub", async () => {
  await writeFile(
    join(directory, "artifacts/site/paperwarden.html"),
    "Altered",
  );
  await expect(invoke(release, ["--check"])).rejects.toThrow(
    "Prepared paperwarden.html differs",
  );
  await expect(readFile(join(directory, "calls.log"))).rejects.toThrow();
});

test("rejects release assets or original source trees that differ from their claimed content", async () => {
  await invoke(release, ["--publish"]);
  await writeFile(join(directory, "published/paperwarden.html"), "Altered");
  await expect(invoke(release, ["--check"])).rejects.toThrow(
    "Published paperwarden.html differs",
  );
  await writeFile(join(directory, "published/paperwarden.html"), reader);
  const remotePath = join(directory, "remote.json");
  const remote = JSON.parse(await readFile(remotePath, "utf8"));
  await writeFile(remotePath, JSON.stringify({ ...remote, tamperTree: true }));
  await expect(invoke(release, ["--check"])).rejects.toThrow(
    "release source dist/paperwarden.html differs",
  );
});
