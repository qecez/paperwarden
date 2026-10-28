# Paperwarden

Encrypted paper backups, created and opened in your browser.

Paperwarden encrypts text into a printable QR code. Each backup can contain up to four messages, each protected by a different password.

The app is available as a single HTML file. Download it to create and recover backups offline, without an account or installation.

**Status:** Experimental. The cryptographic design and implementation have not had an independent security audit.

## Get started

1. Open [paperwarden.com](https://paperwarden.com/) or a [verified offline copy](#verify-your-copy) of the app.
2. Choose **Encrypt**, then enter a message and a strong, unique password. Use **Add another message** if needed.
3. Choose **Create backup**, then **Print backup**. Print at 100% with the QR's full white border.
4. Scan the actual print and check that you can recover each message before storing it.
5. Choose **Download offline app** and keep that file for recovery without the website.

Store passwords separately from printed backups. **Save encrypted text** provides another copy of the same backup. The downloaded app contains no messages, passwords, or backups; save those encrypted backups separately.

## Recover a backup

Open Paperwarden, choose **Decrypt**, and scan the QR or choose a QR image. **Paste backup** also accepts saved encrypted text, a complete backup link, or the printed written copy.

Compare the six-word **Backup ID** with the one on your paper, then enter the message's password. Each password opens only its matching message. Lost passwords cannot be reset.

A phone camera can open the website from the QR link. If the website is unavailable, open your downloaded app and import the QR image or paste the complete link there. Recovery happens locally and does not require contacting the linked website. Camera access depends on your browser; importing a photo is an alternative.

See [recovery instructions](docs/RECOVERY.md) for image formats, written-copy recovery, and printing guidance.

## Security and plausible deniability

Encryption and decryption run on your device. The app does not upload or automatically save messages or passwords. Use a trusted device and app; a compromised website, browser, or extension can expose what you enter.

Every backup has the same size and no visible message count. Separate passwords allow you to reveal one message without listing the others. This is designed to support limited plausible deniability: opening a later message reveals space used by earlier messages, and disclosed message lengths can rule out room for additional messages. There is no formal deniability proof or guarantee of protection under coercion.

The [threat model](docs/THREAT_MODEL.md) explains these limits. The [format specification](docs/FORMAT.md) documents encryption, shared capacity, and QR encoding. The current PWN-1 format does not open backups from earlier prototypes.

## Verify your copy

A SHA-256 checksum identifies the exact contents of the downloaded HTML file. Check it **before opening the file**.

The expected checksum is the 64-character value in [`dist/paperwarden.html.sha256`](dist/paperwarden.html.sha256) for the same build as your download. Choose a commit from a successful [public verification and deployment run](https://github.com/qecez/paperwarden/actions/workflows/ci.yml), then view the checksum file at that commit. The checksum changes whenever the app changes.

In the folder containing your download, run the command for your system:

| System             | Command                                             |
| ------------------ | --------------------------------------------------- |
| macOS              | `shasum -a 256 paperwarden.html`                    |
| Linux              | `sha256sum paperwarden.html`                        |
| Windows PowerShell | `Get-FileHash .\paperwarden.html -Algorithm SHA256` |

Use your actual filename if it differs. Compare all 64 characters with the expected checksum; uppercase and lowercase letters are equivalent. If they differ, do not use that copy.

A matching checksum confirms that the file matches the chosen version. A checksum supplied by a compromised website could be replaced alongside the file. For stronger verification, see [how to rebuild the app, verify its signed build attestation, and compare the live website with the source](docs/HOSTING.md).

## Development

Use Node 24 LTS.

```sh
npm ci
npm run check
npm run test:browser
npm run dev
```

`npm run build` produces `dist/paperwarden.html` and its SHA-256 checksum. Commit both together. The build is reproducible and includes all runtime code, fonts, and dependency notices. `npm run preview` serves it at `http://127.0.0.1:4175/`.

Browser tests use Chromium. On macOS they use installed Google Chrome by default; set `CHROMIUM_PATH` to use another executable. On Linux, run `npx playwright install --with-deps chromium`. PDF recovery tests also require Poppler. See [validation](docs/VALIDATION.md) for test coverage, setup, and remaining limitations.

Independent reference checks are available in `scripts/reference-vector.py` and `scripts/reference-link.py`. The envelope check needs Python's `cryptography` package with Argon2id support; the link check uses only the standard library.

The source separates [cryptography](src/crypto/), [the backup format](src/format/), [encoding and QR recovery](src/encoding/), [the interface](src/main.ts), and [printing](src/print/). [Build scripts](scripts/) produce the standalone app and verify deployments.

MIT licensed. Bundled font, styling, and word-list notices are preserved in [`docs/licenses/`](docs/licenses/) and the downloadable app.
