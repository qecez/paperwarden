import { afterAll, beforeAll, expect, test } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const prepare = fileURLToPath(
  new URL("../scripts/prepare-site.mjs", import.meta.url),
);
const verify = fileURLToPath(
  new URL("../scripts/verify-live.mjs", import.meta.url),
);
const reader = Buffer.from(
  "<!DOCTYPE html><html><head></head><body>Fixture</body></html>",
);
const digest = createHash("sha256").update(reader).digest("hex");
const specification = Buffer.from("# PWN-1\n\nPublic test specification.\n");
const specDigest = createHash("sha256").update(specification).digest("hex");
let directory: string;
let commit: string;
let server: Server;
let origin: string;
let mode:
  "valid" | "modified" | "redirect" | "stale" | "wrong-spec" | "changed-spec" =
  "valid";
const environment = {
  ...process.env,
  GITHUB_SHA: undefined,
  GITHUB_RUN_ID: undefined,
  GITHUB_REPOSITORY: undefined,
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "paperwarden-deployment-"));
  await mkdir(join(directory, "dist"));
  await mkdir(join(directory, "docs"));
  await writeFile(join(directory, "docs/FORMAT.md"), specification);
  await writeFile(join(directory, "dist/PWN-1.md"), specification);
  await writeFile(
    join(directory, "dist/PWN-1.md.sha256"),
    `${specDigest}  PWN-1.md\n`,
  );
  await writeFile(join(directory, ".gitignore"), "artifacts/\n");
  await writeFile(join(directory, "dist/paperwarden.html"), reader);
  await writeFile(
    join(directory, "dist/paperwarden.html.sha256"),
    `${digest}  paperwarden.html\n`,
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory });
  git("init", "--quiet");
  git("add", ".");
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
  commit = git("rev-parse", "HEAD").toString().trim();
  await run(process.execPath, [prepare], { cwd: directory, env: environment });
  server = createServer(async (request, response) => {
    const path = request.url === "/" ? "index.html" : request.url?.slice(1);
    if (mode === "redirect" && request.url === "/") {
      response.writeHead(302, { Location: "/paperwarden.html" }).end();
      return;
    }
    const type =
      path === "deployment.json"
        ? "application/json"
        : path?.endsWith(".sha256") || path?.endsWith(".md")
          ? "text/plain"
          : "text/html";
    response.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store, no-transform",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "frame-ancestors 'none'",
    });
    const body = await readFile(join(directory, "artifacts/site", path!));
    if (mode === "modified" && request.url === "/") {
      response.end(body.toString().replace("Fixture", "Altered"));
    } else if (
      (mode === "stale" || mode === "wrong-spec") &&
      path === "deployment.json"
    ) {
      const manifest = JSON.parse(body.toString());
      if (mode === "stale") manifest.commit = "0".repeat(40);
      else manifest.specSha256 = "f".repeat(64);
      response.end(JSON.stringify(manifest));
    } else if (mode === "changed-spec" && path === "PWN-1.md") {
      response.end(body.toString().replace("Public", "Secret"));
    } else response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test port");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("packages the committed bytes and verifies live responses against an independent commit", async () => {
  expect(await readFile(join(directory, "artifacts/site/index.html"))).toEqual(
    reader,
  );
  expect(
    await readFile(join(directory, "artifacts/site/paperwarden.html")),
  ).toEqual(reader);
  expect(await readFile(join(directory, "artifacts/site/PWN-1.md"))).toEqual(
    specification,
  );
  const manifest = JSON.parse(
    await readFile(join(directory, "artifacts/site/deployment.json"), "utf8"),
  );
  expect(manifest).toMatchObject({
    format: "PWN-1",
    schemaVersion: 2,
    readerSha256: digest,
    specSha256: specDigest,
    release: `https://github.com/qecez/paperwarden/releases/tag/sha256-${digest}`,
  });
  const { stdout } = await run(
    process.execPath,
    [verify, origin, "--commit", commit],
    { cwd: directory },
  );
  expect(stdout).toContain(`against ${commit}; SHA-256 ${digest}`);
});

test("refuses a dirty tracked artifact before preparing publication", async () => {
  const path = join(directory, "dist/paperwarden.html");
  await writeFile(path, "Uncommitted reader");
  try {
    await expect(
      run(process.execPath, [prepare], { cwd: directory, env: environment }),
    ).rejects.toThrow("Commit tracked changes");
  } finally {
    await writeFile(path, reader);
  }
});

test("verifies a new deployment of unchanged reader bytes against the original reader tag", async () => {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory });
  const tag = `sha256-${digest}`;
  try {
    git("tag", tag, commit);
    await writeFile(
      join(directory, "docs/HOSTING.md"),
      "New hosting configuration.\n",
    );
    git("add", "docs/HOSTING.md");
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
      "Hosting change",
    );
    const later = git("rev-parse", "HEAD").toString().trim();
    await run(process.execPath, [prepare], {
      cwd: directory,
      env: environment,
    });
    const path = join(directory, "artifacts/site/deployment.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.readerSourceCommit = commit;
    await writeFile(path, JSON.stringify(manifest));
    const { stdout } = await run(
      process.execPath,
      [verify, origin, "--commit", later],
      { cwd: directory },
    );
    expect(stdout).toContain(`against ${later}; SHA-256 ${digest}`);
    const explicit = await run(
      process.execPath,
      [verify, origin, "--commit", later, "--reader-commit", commit],
      { cwd: directory },
    );
    expect(explicit.stdout).toContain(`against ${later}`);
    await expect(
      run(
        process.execPath,
        [verify, origin, "--commit", later, "--reader-commit", later],
        { cwd: directory },
      ),
    ).rejects.toThrow("manifest does not match");
  } finally {
    git("reset", "--hard", commit);
    git("tag", "--delete", tag);
    await run(process.execPath, [prepare], {
      cwd: directory,
      env: environment,
    });
  }
});

test("refuses a committed checksum that does not match the reader", async () => {
  const file = "dist/paperwarden.html.sha256";
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory });
  try {
    await writeFile(
      join(directory, file),
      `${"0".repeat(64)}  paperwarden.html\n`,
    );
    git("add", file);
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
      "Mismatched fixture",
    );
    await expect(
      run(process.execPath, [prepare], { cwd: directory, env: environment }),
    ).rejects.toThrow("checksum for paperwarden.html does not match");
  } finally {
    git("reset", "--hard", commit);
  }
});

test.each([
  ["modified", "live reader differs"],
  ["redirect", "fetch failed"],
  ["stale", "manifest does not match"],
  ["wrong-spec", "manifest does not match"],
  ["changed-spec", "live specification differs"],
] as const)("rejects %s deployment responses", async (fault, message) => {
  mode = fault;
  try {
    await expect(
      run(process.execPath, [verify, origin, "--commit", commit], {
        cwd: directory,
      }),
    ).rejects.toThrow(message);
  } finally {
    mode = "valid";
  }
});
