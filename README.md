# Paperwarden

[![Release](https://img.shields.io/badge/release-latest-64748b)](https://github.com/qecez/paperwarden/releases/latest) [![License: MIT](https://img.shields.io/badge/license-MIT-64748b)](LICENSE)

**Encrypted paper backups you can recover offline.**

Paperwarden turns short, important text—passwords, recovery codes, private keys, or instructions for your family—into a password-protected backup you can print and store. One backup holds one or two messages, each protected by a separate password, within one fixed-size QR code.

Backup drives fail, phones get stolen, and accounts get locked. Paper needs no power or subscription. The QR contains the encrypted data itself, so a saved reader can recover it without the website, an account, or this project continuing to exist.

## One file, ready to use

The complete application is one self-contained `paperwarden.html` file. Download it from [paperwarden.com](https://paperwarden.com/) or the official [GitHub releases](https://github.com/qecez/paperwarden/releases), [verify its checksum](#verify-the-app), and open the saved file in a compatible browser.

No installation, local server, or internet connection is required to create or open a backup with the saved app. Its scripts, cryptographic code, QR tools, fonts, word lists, and notices are embedded. Node.js and npm are needed only for development.

The repository's built reader is [`dist/paperwarden.html`](dist/paperwarden.html). The root `index.html` is the development entry point.

## Create now. Recover later.

### Make a backup

1. Open [paperwarden.com](https://paperwarden.com/), choose **download the app** in the footer, and [verify the file](#verify-the-app) before opening it. The download contains the app, without entered messages, passwords, or backups.
2. In **Encrypt**, enter a message and password. The dice button generates eight random words. Record the password separately. **Add message** adds another message with its own password.
3. Choose **Create backup**, select **A4** or **US Letter**, then **Save PDF**. Print the PDF at 100% with the QR's complete white border and keep every page. **Save as text** downloads the same checksummed text block, named with the backup's four-word ID.
4. Use the saved app to recover every message from a photo or scan of the actual print before storing it.

The PDF contains four pages: the QR and Backup ID, two pages of checksummed encrypted text, and a technical recovery reference. Keep all four. The written copy provides another route to recovery if the QR is damaged; it is encrypted too and still requires your password.

The QR is 150 mm square including its white border. Choose the matching paper size when printing, and check that the PDF viewer and printer have not scaled or cropped it. The PDF fixes the page layout, but only testing your actual print establishes that your recovery device can read it.

### Recover a backup

1. Open your verified, saved app and choose **Decrypt**.
2. Choose **Scan QR code** or **Choose QR image**, or paste the text copy or QR-generated link. Pasted text loads automatically.
3. Compare the four-word Backup ID shown in the app with your paper. Matching words help identify the backup but do not authenticate it.
4. Enter the password for the message you want to recover and choose **Decrypt backup**.
5. Use **Clear text** to return to password entry for the same backup, or **Load another backup** to clear it and import a different one.

If the QR is damaged, paste or transcribe the complete written copy, including its BEGIN/END markers, format heading, full SHA-256 fingerprint, all 115 numbered lines, and their checksums. The reader checks the transcription before asking for your password.

See [recovery instructions](docs/RECOVERY.md) for damaged QRs and recovery without the app.

## Keep the means to recover it

The app download is a clean copy of the reader. It contains no entered messages, passwords, or generated backups. Preserve the encrypted paper, PDF, or text copy separately from the reader and its password. Generated passwords are not automatically saved.

Keeping the reader removes the need to find it online later, but it cannot guarantee indefinite browser compatibility. Keep the [frozen specification](docs/FORMAT.md) and [public test vectors](tests/fixtures/reference.json) with it, and periodically check recovery on your current device. The printed technical reference also supports implementing a reader if the original app can no longer run.

**For family:** Use the non-sensitive notes area to identify the paper and the saved app's location; do not write secrets there. Tell your family how many messages exist and who has each password. Keep passwords apart from the paper and spare copies in different places.

Passwords for an existing backup cannot be changed or reset. To use a different password, create a new backup.

## Security limits

Anyone with the backup can guess passwords offline without a rate limit. Use generated passwords or strong, independently chosen ones: knowing one must not help guess another. The seven-character minimum for custom passwords is a length check, not a strength estimate. The [password-generation analysis](docs/THREAT_MODEL.md#password-generation) states the generator's entropy and assumptions.

The app does not upload or automatically save messages or passwords. A compromised device, browser, extension, or reader can still expose them. For high-value secrets, prefer a freshly installed, trusted system. Download and verify the app, then go offline before entering secrets. A fresh browser without extensions does not make an untrusted device safe; closing the app does not guarantee memory erasure.

Scanning the QR with a phone camera may open the website. This is a convenience for casual use; for important backups, use your verified app offline. The website's reader can access the encrypted backup and any password entered there. Importing a QR image or link into your saved app works locally without contacting the website. Don't use a camera's Search option, which sends the QR's text to a search provider.

Paper can be lost or damaged. Store prints away from light and moisture, keep spare copies, and test the actual print and recovery device.

The [threat model](docs/THREAT_MODEL.md) describes the assumptions and remaining limits; [validation](docs/VALIDATION.md) describes what the tests cover. Automated and digital checks do not replace independent cryptographic review or testing actual printers, cameras, lighting conditions, and devices.

## Encryption and the PWN-1 format

Paperwarden uses the documented [PWN-1 format](docs/FORMAT.md):

- **Argon2id** derives password material using a fixed profile of 64 MiB memory, three iterations, and parallelism one.
- **HKDF-SHA256** derives separate keys for encrypted headers and message data.
- **AES-256-GCM** encrypts and authenticates each protected message and its header.

Passwords are Unicode NFC-normalized without trimming or case folding. Spaces and capitalization remain significant. Message text preserves its original whitespace and newlines.

A strong password matters because encryption cannot prevent someone holding the backup from attempting guesses. The Backup ID, full fingerprint, and text-line checksums help identify copies and detect copying errors; they are not digital signatures or proof of who created the backup.

## Limited plausible deniability

A backup can hold one or two messages, each with its own password. This offers plausible deniability: revealing one password doesn't necessarily reveal that another message exists. But there are limits. A long message can leave no room for another message. It can't make anyone believe you, so don't rely on it if your safety is at risk.

Every backup is exactly 2,858 bytes, with no public message count. One message can use 2,776 UTF-8 bytes; two messages share 2,718 text bytes. Each record has 58 bytes of overhead. Records share one circular body in input order, starting at a private random position. One disclosed position alone does not reveal order or earlier occupied space.

Related passwords, observed creation, and device artifacts can expose information the layout does not hide. Opening one message authenticates that message, not the rest of the backup; a replacement can preserve one message while changing another. The [threat model](docs/THREAT_MODEL.md) describes the assumptions and limits of one-password disclosure. Tests do not establish a deniability proof.

## Verify the app

The full SHA-256 digest identifies an exact `paperwarden.html`; `PWN-1` identifies the frozen backup format. [Releases](https://github.com/qecez/paperwarden/releases) contain the reader, specification, checksums, deployment record, and [release notes](CHANGELOG.md). **About → Build** shows the reader’s abbreviated SHA-256. The verification guide links to its release.

Before opening a download, get its matching `paperwarden.html.sha256` from the official GitHub release and keep both files in the same folder. **verify it** in the website footer (or **Verify it** in a saved copy) explains the commands for macOS, Windows, and Linux; keep the checksum file before disconnecting. The [verification guide](docs/HOSTING.md#check-an-offline-download) also covers source rebuilds and signed attestations.

[paperwarden.com](https://paperwarden.com/) is deployed to Cloudflare Workers by [GitHub Actions](https://github.com/qecez/paperwarden/actions/workflows/ci.yml). After tests and a reproducible build check, the workflow publishes an immutable GitHub release. A separate production job downloads and verifies that release before deploying it; no application build runs with the hosting credential. A final job checks the live bytes and updates the [GitLab source mirror](https://gitlab.com/qecez/paperwarden). The [hosting contract](docs/HOSTING.md#publication-contract) describes the controls and their limits.

A matching checksum establishes file equality, not software safety. The app's **Build** label and links are conveniences, not an independent check: a compromised app can falsify them.

## Development and review

Use Node 24 and the pinned lockfile:

```sh
npm ci
npm run format:check
npm run check
npm run test:browser
```

`npm run build` writes the reader, frozen specification, and their checksums to `dist/`; commit all four files together. Each new reader also needs a [release-note entry](docs/HOSTING.md#release-notes) keyed to its digest. `npm run dev` starts Vite; `npm run preview` serves the built app at `http://127.0.0.1:4175/`. [Validation](docs/VALIDATION.md) covers browser/Poppler setup, independent Python references, and untested conditions.

The build keeps JavaScript unminified and embeds all runtime code, fonts, word lists, and notices. The three runtime dependencies provide Argon2id (`hash-wasm`), QR generation (`qrcode`), and QR decoding (`@zxing/library`); only used modules are bundled.

Start with the [format](docs/FORMAT.md) and [threat model](docs/THREAT_MODEL.md), then review these boundaries:

| Boundary                                    | Source                                                   |
| ------------------------------------------- | -------------------------------------------------------- |
| Key derivation and authenticated encryption | [src/crypto](src/crypto/)                                |
| Envelope validation and circular placement  | [src/format](src/format/)                                |
| Text, links, and QR input                   | [src/encoding](src/encoding/)                            |
| Browser state and cancellation              | [src/main.ts](src/main.ts)                               |
| Encrypted-only print output                 | [src/print](src/print/)                                  |
| Build and publication                       | [scripts](scripts/), [hosting contract](docs/HOSTING.md) |

## License

Paperwarden is [MIT licensed](LICENSE).
