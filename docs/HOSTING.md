# Reader identity and publication

The website and offline download contain identical `paperwarden.html` bytes. A release contains the reader, frozen `PWN-1.md` specification, their SHA-256 checksums, and a detached deployment record.

| Identifier          | Meaning                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `PWN-1`             | Frozen backup interpretation and recovery procedure.                                                    |
| Full reader SHA-256 | Exact HTML contents; release tag `sha256-<64 lowercase hexadecimal characters>`.                        |
| Source commit       | Source and build instructions; signed attestations bind artifacts to the producing workflow and commit. |

A checksum proves equality with a chosen file, not its safety or trustworthiness. The format specification supports independent recovery but does not authenticate an app.

## Check an offline download

Before opening a downloaded app, download `paperwarden.html` and `paperwarden.html.sha256` from its official [GitHub release](https://github.com/qecez/paperwarden/releases). If you already have the app, get its matching checksum file. Keep both files in the same folder; the commands below expect the app to be named `paperwarden.html`.

The footer's verification link opens these instructions locally. When the app can identify its build, the guide links to that exact release. Otherwise it links to the release list. When viewing this document at a release tag, [the reader's checksum](../dist/paperwarden.html.sha256) identifies that build; the document on `main` follows the current source instead.

Open Terminal or PowerShell in the folder containing both files and run the command for your system.

### macOS

```sh
shasum -a 256 -c paperwarden.html.sha256
```

### Windows (PowerShell)

```powershell
try {
  $expected = (Get-Content .\paperwarden.html.sha256 -Raw -ErrorAction Stop).Split()[0]
  $actual = (Get-FileHash .\paperwarden.html -Algorithm SHA256 -ErrorAction Stop).Hash
  if ($actual -eq $expected) { "OK" } else { "FAILED" }
} catch {
  "FAILED"
}
```

### Linux

```sh
sha256sum -c paperwarden.html.sha256
```

`OK` means the file matches the checksum. If the check fails, don't use the app. A match confirms equality with the published release, not software safety. Obtain the checksum from the official release before disconnecting, and keep the verified app, specification, and checksums together.

About's **Build** label shows the first 12 characters of the reader's SHA-256; the full digest identifies its release and checksum links. The app computes this from its pristine, canonical downloadable HTML, captured before interaction. It does not independently read the file on disk, and browser parsing can normalize modified or noncanonical bytes. This identifies a build without authenticating the app. No release data is fetched automatically.

The footer's saved-copy wording means only `location.protocol === "file:"`, not that the device is disconnected or the app is verified. The website offers **download the app**; both copies keep the built-in guide available.

The app's links and build label are conveniences, not independent trust anchors. A compromised app can falsify both. For stronger provenance checks, select trusted source and verify it independently.

## Independently verify a release

Choose a full commit from a successful [publication workflow](https://github.com/qecez/paperwarden/actions/workflows/ci.yml), compare it with a source you trust, and inspect the source and [workflow](../.github/workflows/ci.yml). A later documentation or hosting commit may approve the same reader bytes as an earlier release. Do not trust a commit solely because the website names it. With Git, Node 24, and a current GitHub CLI:

```sh
git clone https://github.com/qecez/paperwarden.git
cd paperwarden
PAPERWARDEN_COMMIT=REPLACE_WITH_THE_FULL_40_CHARACTER_COMMIT
git checkout --detach "$PAPERWARDEN_COMMIT"
npm ci
npm run build
git diff --exit-code -- dist/

PAPERWARDEN_SHA256=$(cut -c1-64 dist/paperwarden.html.sha256)
gh release download "sha256-$PAPERWARDEN_SHA256" \
  --repo qecez/paperwarden --dir downloaded-release
for file in paperwarden.html paperwarden.html.sha256 PWN-1.md PWN-1.md.sha256; do
  cmp "dist/$file" "downloaded-release/$file" || exit 1
done
```

The rebuild and downloaded release must reproduce all four committed distribution files. Check GitHub's immutable release proof and the downloaded assets:

```sh
gh release verify "sha256-$PAPERWARDEN_SHA256" --repo qecez/paperwarden
for file in downloaded-release/*; do
  gh release verify-asset "sha256-$PAPERWARDEN_SHA256" "$file" \
    --repo qecez/paperwarden || exit 1
done
```

Then verify the reader's workflow attestation against the selected source:

```sh
gh attestation verify downloaded-release/paperwarden.html \
  --repo qecez/paperwarden \
  --cert-identity https://github.com/qecez/paperwarden/.github/workflows/ci.yml@refs/heads/main \
  --source-ref refs/heads/main \
  --source-digest "$PAPERWARDEN_COMMIT" \
  --signer-digest "$PAPERWARDEN_COMMIT" \
  --deny-self-hosted-runners
```

The source and signer digest constraints pin the approving source and workflow version. Each publication attests the four distribution files and its current `deployment.json`, even when the reader is unchanged. The release's original `deployment.json` remains attested by its original commit. GitHub's native release proof binds the original release assets and tag independently of these later attestations. To inspect older workflow attestations, increase the CLI's `--limit` or use a saved attestation `--bundle`; its default lookup is bounded. See [GitHub's attestation documentation](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).

Rebuilding connects source to bytes; attestation identifies the producing workflow. Neither establishes that code, dependencies, or workflow are safe. Repository owners can change GitHub data. Preserve trusted commits and attestations independently when long-term verification matters.

## Verify the live deployment

```sh
node scripts/verify-live.mjs https://paperwarden.com \
  --commit "$PAPERWARDEN_COMMIT" --attempts 12
```

The script compares `/` and `/paperwarden.html` with the committed reader, then checks the specification, checksums, deployment record, and security headers. It rejects redirects, oversized responses, and inconsistent identities without executing the page. Each request times out after 15 seconds; failed attempts wait five seconds.

Deployment and reader source may differ when only documentation or hosting changes. An unchanged reader retains its original release. The verifier finds that source through the local `sha256-…` tag, or accepts `--reader-commit <full-commit>`. Both source commits must be available and contain identical reader/specification files. `--commit` defaults to local `HEAD`.

Successful verification describes the responses received during that check, not what every visitor receives. Retain a verified reader and use it offline for sensitive work.

## Publication contract

The [workflow](../.github/workflows/ci.yml) separates four jobs, each on a fresh runner:

1. **Verify** runs type, lint, unit, independent-reference, browser, and reproducibility checks. It has read-only repository access and no deployment credentials.
2. **Release** prepares the committed distribution files, checks the authored release notes, and attests the reader, specification, checksum files, and deployment record. It uploads all five assets to a draft, verifies them, and publishes the release. Publication must produce a natively immutable release before deployment can start. This job can write GitHub releases and attestations, but has no Cloudflare or GitLab key.
3. **Deploy** downloads that published release and verifies GitHub's release and asset proofs, workflow attestations, full digests, and equality with the approved source. The four distribution files and current deployment record must be attested by the current commit; the original release record remains tied to its original commit. It installs only the pinned Wrangler tool from `deployment/package-lock.json`, with lifecycle scripts disabled. It runs no application or build scripts. The Cloudflare credential is exposed only to the final upload step; the generated configuration names the existing Worker and requests no domain-routing changes.
4. **Mirror** checks the live reader, specification, headers, and deployment record, then updates GitLab. Its separate environment holds only the mirror key.

GitHub's [immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases) lock the published assets and tag; release titles and notes remain editable. The publisher requires authored notes for a new reader and rejects inconsistent release identities. A failed deployment leaves a published release available for inspection and retry.

Hosting-only changes retain the original reader release and its `readerSourceCommit`. The current deployment gets a separately attested `deployment.json` naming its own source commit and workflow run. The original release record remains unchanged. Inconsistent or incomplete publication fails rather than replacing published files.

After committing source and generated files, inspect the release plan locally with:

```sh
node scripts/prepare-site.mjs
node scripts/release.mjs --check
```

Preparation requires `GITHUB_SHA`, if set, to equal `HEAD`, and rejects modified tracked files. Output goes to ignored `artifacts/site/`. The release check needs GitHub access. The workflow uses `--publish` before deployment; this command is not a local build step.

### Repository and account policy

Publication requires GitHub's release immutability setting. Keep `main` protected against force pushes and deletion, require the verification check for updates, and protect `sha256-*` release tags against replacement. Preserve published history; corrections belong in later commits and reader releases. Restrict the `release`, `production`, and `mirror` environments to `main`, with credentials separated as above.

Protect the GitHub, Cloudflare, and domain accounts with strong authentication. Scope the deployment token as narrowly as Cloudflare supports, without DNS or routing permissions. Workflow, tool, and policy changes need the same review as application changes.

These controls constrain the normal publication path; Cloudflare does not independently enforce a GitHub release signature. A hosting-account owner or compromised account can serve other code, change policies, or target selected visitors. Public releases and workflow runs provide evidence of approved publication, not proof of every response. Keep a verified offline reader for sensitive work.

## Release notes

[CHANGELOG.md](../CHANGELOG.md) is the authored source for GitHub release notes. Keep entries newest first and preserve published entries. Describe changes in terms of their effect on users. For security or recovery fixes, identify affected builds, whether existing backups are affected, and what users should do.

For a new reader:

1. Write a short entry with a descriptive title and a release link in its heading: `## [Title](https://github.com/qecez/paperwarden/releases/tag/sha256-<64 lowercase hex characters>)`.
2. Build and test the final app. Set the entry's link to the full digest in `dist/paperwarden.html.sha256`.
3. Commit the source, all four distribution files, and changelog together. The publisher selects the matching entry and includes it with the release's source and checksum information.

The changelog is not embedded in the HTML, so recording the digest does not change the build it identifies. SHA-256 identifies reader releases; PWN-1 identifies the frozen backup format. There is no separate app version counter.

Documentation or hosting changes that leave the HTML unchanged retain the original release and notes. Do not rewrite a published entry to describe a later deployment. **verify it → matching GitHub release** links to the saved reader's exact release without fetching release data in the app.

## Hosting constraints

The Cloudflare Worker serves static assets only, with no password endpoint, remote asset loader, or service worker. Domain routing is provisioned separately. Releases use the restricted Worker configuration generated in the deployment job. An internal `/` → `/index.html` proxy serves the unchanged reader without a browser redirect.

Generated headers disable caching and transformations, suppress referrers, prevent framing, and declare text-file MIME types. The HTML's hash-based CSP denies network connections while permitting the bundled worker and WebAssembly. Camera scanning remains subject to browser permissions. Do not enable hosting features that inject scripts or rewrite HTML. Compression must decompress to the original bytes.

For `paperwarden.com`, HTTP and `www` redirect to the HTTPS apex. TLS 1.2 is the minimum; HSTS lasts 30 days without subdomain inheritance or preload. DNSSEC signs the zone. Keep browser network-error reporting and HTML/script rewriting disabled; verify the served bytes after hosting changes.

The domain neither sends nor receives email. Its DNS policy is:

| Name           | Type | Value                                             |
| -------------- | ---- | ------------------------------------------------- |
| `@`            | MX   | Priority `0`, target `.` (null MX)                |
| `@`            | TXT  | `v=spf1 -all`                                     |
| `*._domainkey` | TXT  | `v=DKIM1; p=`                                     |
| `_dmarc`       | TXT  | `v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s;` |

These records tell receiving mail systems to reject unauthorized mail claiming this domain or its subdomains. Enforcement belongs to the recipient's mail system; the policy does not cover lookalike domains.

The host controls code that receives passwords. URL fragments stay out of HTTP requests, but ordinary visits are visible to the host.

Keep release files, source, attestations, and specifications outside the hosting service; workflow artifacts expire. [Recovery](RECOVERY.md) and [validation](VALIDATION.md) describe offline and device checks.

## GitLab mirror

After release publication, deployment, and live verification, a separate job pushes
`main` and that release tag to [GitLab](https://gitlab.com/qecez/paperwarden).
GitHub remains canonical. This is a source mirror; GitHub release assets, issues,
and attestations are not copied.

`scripts/mirror.mjs` uses the `mirror` environment's `GITLAB_MIRROR_SSH_KEY`,
a write deploy key enabled only for that GitLab project. GitLab's SSH host key is
pinned. The job does not force-push or delete refs, and pull requests cannot use
the key. Changes made directly in the mirror can cause synchronization to fail.
Rotate the deploy key before its 2027-11-03 expiry and update the GitHub secret;
keep it permitted to push the mirror's protected `main` branch.
