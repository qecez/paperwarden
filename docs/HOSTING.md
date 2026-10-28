# Hosting and verifying the app

Every generated QR links to `https://paperwarden.com/`. The public repository is [qecez/paperwarden](https://github.com/qecez/paperwarden). A downloaded copy of the app can recover these backups offline, including from a photo, SVG image, or pasted link.

## Check a downloaded copy

A SHA-256 checksum identifies the exact contents of a file. Check your downloaded `paperwarden.html` before opening it:

1. Choose the source commit from a successful [public deployment run](https://github.com/qecez/paperwarden/actions/workflows/ci.yml), or another source you trust. Open `dist/paperwarden.html.sha256` **at that commit**. Its first 64 hexadecimal characters are the expected checksum. Use the exact build you downloaded; the displayed app version alone may be shared by several builds. If you are unsure which build you have, download `dist/paperwarden.html` from the chosen commit too.
2. Open Terminal or PowerShell in the folder containing your download and run the command for your system. Adjust the filename if your browser renamed the download.

| System             | Command                                             |
| ------------------ | --------------------------------------------------- |
| macOS              | `shasum -a 256 paperwarden.html`                    |
| Linux              | `sha256sum paperwarden.html`                        |
| Windows PowerShell | `Get-FileHash .\paperwarden.html -Algorithm SHA256` |

3. Compare the result with the expected checksum. Every character must match; uppercase and lowercase letters mean the same thing. If they differ, do not use the file. Confirm that you chose the matching version, then download and check it again.

Keep the verified file and its checksum together. A matching checksum establishes that your file matches the chosen original; it does not establish that the original is trustworthy. A checksum taken only from the website cannot independently verify that website, because a compromised host could replace both. The build and attestation checks below provide stronger evidence of where the file came from.

## What the deployment proves

The public [Verify and deploy reader workflow](https://github.com/qecez/paperwarden/actions/workflows/ci.yml) rebuilds the standalone reader, checks that it exactly matches the committed file, and runs the automated checks before publication. The HTML has a GitHub artifact attestation linking its SHA-256 to the repository, source commit, and workflow. The deployment uploads the same bytes to Cloudflare and compares the live responses against that commit.

The site serves `dist/paperwarden.html` unchanged at both `/` and `/paperwarden.html`. `/deployment.json` identifies the source commit and reader checksum, with the workflow run when prepared in GitHub Actions. `/paperwarden.html.sha256` contains the standalone file's checksum. Deployment metadata stays outside the reader, so saving it offline preserves the same verifiable bytes.

These are useful, independently checkable claims, not proof that the software has no bugs or that a host can never be compromised. A hash or “verified” label supplied by the website alone cannot establish trust: a compromised host could replace both. A successful live check describes the responses checked, not every response to every visitor. The strongest practical choice for sensitive use is to independently verify a release, save it, and open that copy offline.

## Independently check a release

Choose a full source commit from a successful **public GitHub workflow run** or another source you trust. Do not choose it solely because the website's manifest names it. Inspect that commit and its workflow. With Git, Node 24, and the GitHub CLI installed:

```sh
git clone https://github.com/qecez/paperwarden.git
cd paperwarden
PAPERWARDEN_COMMIT=REPLACE_WITH_THE_FULL_40_CHARACTER_COMMIT
git checkout --detach "$PAPERWARDEN_COMMIT"
npm ci
npm run build
git diff --exit-code -- dist/paperwarden.html dist/paperwarden.html.sha256
node scripts/verify-live.mjs --commit "$PAPERWARDEN_COMMIT"
```

The verification script compares both live HTML responses byte for byte against the file stored in the trusted commit, checks the detached manifest and checksum, and requires the expected security headers. It refuses redirects, oversized responses, and stale or mismatched deployments. It does not execute the fetched website.

To keep a verified reader and check its signed provenance:

```sh
curl --fail --proto '=https' --max-time 30 --compressed \
  https://paperwarden.com/ -o live-paperwarden.html
cmp dist/paperwarden.html live-paperwarden.html
gh attestation verify live-paperwarden.html \
  --repo qecez/paperwarden \
  --signer-workflow qecez/paperwarden/.github/workflows/ci.yml \
  --source-ref refs/heads/main \
  --source-digest "$PAPERWARDEN_COMMIT" \
  --deny-self-hosted-runners
```

Only use the downloaded reader if all checks pass. Keep the trusted commit, checksum, and reader together. Rebuilding checks the connection between source and file; the attestation checks which workflow produced the attested file. Neither replaces review of the source or its dependencies. [GitHub explains artifact attestations and verification](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations).

## Deployment configuration

The Cloudflare Worker serves static assets only. It has no application backend, password endpoint, remote asset loader, or service worker. `wrangler.jsonc` describes the domain and asset directory. `scripts/prepare-site.mjs` prepares `artifacts/site` from a clean checked-out commit, verifying the committed reader and checksum before copying them. Its internal `/` → `/index.html` rule returns the file directly without a browser redirect. HTML path rewriting is otherwise disabled.

```sh
node scripts/prepare-site.mjs
```

Preparation takes the source commit from `GITHUB_SHA` when present and otherwise from local `HEAD`; it refuses a mismatch with `HEAD` or modified tracked files. `GITHUB_RUN_ID` adds a public run link only for the expected repository. Generated site files are ignored by Git. No source-commit identifier is injected into the self-contained HTML.

The publication workflow is limited to the main branch after successful verification. Cloudflare credentials belong in GitHub's encrypted deployment secrets, scoped to the necessary account and resource permissions. They must never be committed. Pin deployment actions and tool versions, and review workflow changes as carefully as application changes.

The supplied `_headers` disables browser caching and content transformations, preserves MIME types, suppresses referrers, and prevents framing. The reader retains its embedded hash-based Content Security Policy. Camera access remains available for QR scanning. Disable Cloudflare features that inject scripts or rewrite HTML, including analytics injection, Zaraz, Rocket Loader, and email obfuscation. Do not add a login page or consent overlay. Compression is fine when decompression returns the exact original bytes. Cloudflare documents [static-asset headers](https://developers.cloudflare.com/workers/static-assets/headers/) and [internal proxy rules](https://developers.cloudflare.com/workers/static-assets/redirects/#proxying).

After each publication, verify the live domain:

```sh
node scripts/verify-live.mjs https://paperwarden.com --attempts 12
```

The default expected commit is local `HEAD`. Each failed attempt waits five seconds before retrying, up to the requested limit of 12 attempts; individual requests have a 15-second timeout. HTTPS is required except for explicit loopback addresses used by local tests. The base URL cannot contain credentials, a path, a query, or a fragment.

Open a public test backup link on the intended phones. Confirm that Decrypt is selected, the backup is loaded, and a password is required. Print and scan the linked QR on actual devices. Retain the same verified reader offline and test photo/SVG/pasted-link recovery without a connection. Automated checks do not establish native phone-camera or direct local-file behavior on every device.

The browser requests the page without the URL fragment, then extracts the encrypted backup locally. Hosting still exposes ordinary page visits and controls the code that receives passwords. Protect the domain, hosting account, GitHub account, and deployment credentials. Keep the root address compatible with printed links, and preserve releases and format specifications independently. See [recovery](RECOVERY.md), [the transport specification](FORMAT.md), and [validation limits](VALIDATION.md).
