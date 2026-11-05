# Validation

The checks cover specified inputs, state transitions, and interoperability. They do not establish a deniability proof, replace an independent security audit, or certify every browser and printer.

## Run the checks

Use Node 24 and the committed lockfile. Browser tests require Chromium; CI also runs recovery and PDF export checks in Firefox and WebKit. Install the engines with `npx playwright install --with-deps chromium firefox webkit`. On macOS, tests default to installed Google Chrome; set `CHROMIUM_PATH` to use another executable.

PDF checks need Poppler's `pdftoppm` and `pdftotext`. Set `PDFTOPPM_PATH` and `PDFTOTEXT_PATH` if they are outside PATH. Missing tools fail the PDF checks.

The independent envelope reference needs Python `cryptography` with Argon2id support; CI installs `cryptography==48.0.0` in an isolated environment. The link reference uses the standard library. Neither imports application code.

```sh
npm ci
npm run format:check
npm run check
npm run test:browser
python3 scripts/reference-vector.py --check
python3 scripts/reference-link.py --check
```

`npm run check` runs strict TypeScript checking (including unused declarations), ESLint, unit tests, and the build. CI also requires a rebuild to leave every committed distribution file unchanged.

With PowerShell installed, run `pwsh -NoProfile -File tests/check-download.ps1`. CI runs this check too. It executes the Windows instructions extracted from the app and requires them to match the hosting guide. Nine cases cover matching and mismatching hashes, missing files, malformed or empty checksums, and stale variable values. Each case uses normal console error handling; failed reads must return `FAILED`, never `OK`.

Run the additional browser subset with:

```sh
PAPERWARDEN_TEST_BROWSER=firefox npm run test:recovery
PAPERWARDEN_TEST_BROWSER=firefox npm run test:pdf
PAPERWARDEN_TEST_BROWSER=webkit npm run test:recovery
PAPERWARDEN_TEST_BROWSER=webkit npm run test:pdf
```

Public fixture passwords and deterministic randomness are test inputs, never real backup credentials.

## Coverage

| Boundary            | Evidence                                                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keys and envelope   | Independent exact encryption vector; all fixture passwords; one or two messages; shared/full capacity; NFC and UTF-8 handling; malformed fields; wrong passwords; ambiguous headers; authenticated-invalid lengths/text; nonce, tag, and start-position mutations. |
| Circular placement  | Accepted rotation inputs and biased-tail rejection; wrapped headers and data; full-body records; start distribution at each input position; complete header scanning with bounded concurrency.                                                                     |
| Record independence | Damage to an undisclosed region; attacker-chosen insertion into a changed backup; retained readable messages and changed full checksum.                                                                                                                            |
| Passwords and IDs   | Exhaustive word-selection inputs; eight independent draws; failed randomness without fallback; pinned word table; canonical ID bits and four-word abbreviation; matching IDs across imports.                                                                       |
| Encodings           | Independent radix-42 vectors; overflow/leading zeros; strict alphabet, case, framing, and URLs; Base45 bounds; Base32 padding and checksums; malformed archive whitespace at the 10,000-character limit; exact QR bit budget.                                      |
| Browser state       | Two-message recovery; cancelled and stale work; camera cleanup; edits invalidate exports; clean downloads; no unexpected requests or application storage in tested flows.                                                                                          |
| Interface           | Keyboard/accessibility checks; 320-, 390-, 600-, and 1,280-pixel layouts; shared-capacity meters reset after pagehide clears fields; password controls; dialog navigation; donation URI/clipboard/QR checks.                                                       |
| Publication         | Reproducible HTML; committed source/artifact consistency; immutable publication before deployment; release/asset/attestation checks; isolated production and mirror jobs; live bytes, headers, and deployment record.                                              |

The corresponding tests are in [`tests`](../tests/); the [workflow](../.github/workflows/ci.yml) defines the release gate.

### Offline files

Tests download the app after secret entry, About interaction, QR generation, and recovery-link loading. Every download must equal the pristine build without serialized messages, passwords, or backup state.

The actual saved file opens through `file://` in a fresh browser context that is offline before loading. It recovers the wrapped-record fixture from a link naming an unavailable host, generates a password, and rejects unexpected requests, page errors, cookies, or application storage. Its local-file footer remains visible without the download button. Separate tests recover generated QR images and pasted links offline.

Worker tests cover deferred Blob loading, cancellation, and construction failure. A worker and its Blob URL are released together on completion or failure.

### Images and printouts

SVG imports exercise a passive image path: scripts, event handlers, external stylesheets, images, and SVG references remain inactive in tested cases. Checks also reject unsupported types, malformed images, oversized files, and excessive pixel dimensions.

A4 and US Letter PDFs are rasterized at 2,200 and 1,800 pixels and imported as complete pages. Their text copies are extracted, compared with the text download, and decoded to the exact envelope; all tested passwords must recover their messages. Tests also check left-aligned instructions, four-page layout, no entered secrets in print output, and a complete one-page recovery reference. Fixed raster fixtures and fractional-scale cases exercise dense-QR decoding.

Visual inspection is still necessary: text extraction and successful decoding cannot establish readable typography or physical print quality.

### PDF layout contract

**Save PDF** generates the document locally instead of using the browser's print layout. The same encrypted fixture, export implementation, and selected paper size must produce identical PDF bytes. Test A4 and US Letter separately; neither the viewport nor the device's print defaults select the output size. The [PDF export design](PDF_EXPORT.md) describes the writer, font preparation, and trust boundary.

Writer tests check deterministic output, page dimensions, binary stream lengths, cross-reference offsets, structure tags, font identities, Unicode mappings, and rejection of unsupported input. Document checks must independently extract the full archive, decode it with unchanged strict validation, render and scan the QR, and compare both with the original encrypted bytes. Correct ligature extraction, page counts, notes placement, and visible page numbering need inspection alongside those checks. Structure tags alone do not establish PDF/UA conformance or screen-reader usability.

Desktop browser-engine tests cannot complete the device acceptance checks. For each release that changes export or download behavior, test the same fixture and selected paper size in desktop Chrome/Edge, Firefox, Safari, Android Chrome, and actual iPhone Safari. Include portrait/landscape, zoom and accessibility text changes, an offline saved app, and saving, reopening and sharing the PDF. Confirm four pages, unchanged layout, selectable text, working archive copy/paste, and no browser decorations. Record device versions and results; an unperformed check remains unverified. Printer scaling and physical QR recovery require separate print tests.

## Limits and maintenance

WebKit automation is not a test of shipping Safari or iOS. Physical phone cameras, local-file camera permissions, manual screen-reader use, older-device performance, damaged paper, and archival lifetime require separate checks. Test the actual print, saved file, and recovery device before storing valuable information.

Password fields request autocomplete off and sit outside submit forms. Tests check that configuration and absence of an app-requested leave-page warning; browsers and extensions may still offer their own prompts. Clearing fields or closing the app does not establish memory erasure.

Run `npm audit` when reviewing dependency changes. Only modules contributing runtime bytes are bundled, and notices follow those modules. The development-only `minimatch` override pins 11.0.1 for [GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249); review it when upstream tool requirements change.

The [threat model](THREAT_MODEL.md) defines the security claims and remaining assumptions separately from this test inventory.
