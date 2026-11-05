import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Only canonical main and this verified release are copied. No account token,
// force push, branch pruning, or credentials are exposed to pull-request jobs.
const {
  GITHUB_REPOSITORY,
  GITHUB_REF,
  GITHUB_SHA,
  RELEASE_TAG,
  READER_SOURCE_COMMIT,
  GITLAB_MIRROR_SSH_KEY,
} = process.env;
if (
  GITHUB_REPOSITORY !== "qecez/paperwarden" ||
  GITHUB_REF !== "refs/heads/main" ||
  !/^[a-f0-9]{40}$/.test(GITHUB_SHA ?? "") ||
  !/^sha256-[a-f0-9]{64}$/.test(RELEASE_TAG ?? "") ||
  !/^[a-f0-9]{40}$/.test(READER_SOURCE_COMMIT ?? "") ||
  !GITLAB_MIRROR_SSH_KEY
)
  throw new Error("Invalid mirror context");
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (head !== GITHUB_SHA)
  throw new Error("Mirror source differs from verified commit");
const checksum = execFileSync(
  "git",
  ["show", `${READER_SOURCE_COMMIT}:dist/paperwarden.html.sha256`],
  { encoding: "utf8" },
).trim();
if (checksum !== `${RELEASE_TAG.slice(7)}  paperwarden.html`)
  throw new Error("Mirror release differs from verified reader source");
const directory = await mkdtemp(join(tmpdir(), "paperwarden-mirror-"));
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
try {
  const key = join(directory, "key"),
    hosts = join(directory, "known_hosts");
  await writeFile(key, GITLAB_MIRROR_SSH_KEY + "\n", { mode: 0o600 });
  // https://docs.gitlab.com/user/gitlab_com/#ssh-known_hosts-entries
  await writeFile(
    hosts,
    "gitlab.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf\n",
    { mode: 0o600 },
  );
  execFileSync(
    "git",
    [
      "push",
      "--atomic",
      "git@gitlab.com:qecez/paperwarden.git",
      "HEAD:refs/heads/main",
      `${READER_SOURCE_COMMIT}:refs/tags/${RELEASE_TAG}`,
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        GIT_SSH_COMMAND: `ssh -F /dev/null -i ${quote(key)} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${quote(hosts)}`,
      },
    },
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
