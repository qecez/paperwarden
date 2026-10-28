# Validation record — 2026-10-27

This records implementation checks on macOS with Node 24.19.0 and installed Google Chrome, using a clean dependency install. CI is configured for Node 24/Chromium on Linux. None of these results is an external security audit or formal proof of deniability.

## Completed locally

- Strict TypeScript typechecking and ESLint (zero warnings).
- Prettier formatting checks.
- 79 unit/format tests: 1–4 messages, exact single/shared capacity, Unicode and UTF-8 boundaries, password normalization and duplicate rejection, wrong passwords, fresh randomness, malformed public fields, authenticated-invalid offsets/UTF-8, ambiguous valid headers, slot substitution, independent record damage, no forward authenticated-data dependency, strict transport/archive validation, and maximum-density QR raster decoding in both raw and linked modes.
- Backup ID checks pin the complete ordered 2,048-word table by SHA-256, check independently calculated words for the public envelope, cover zero/maximum and every individual identifier bit, and reject malformed digests. The six words retain all 64 bits of the former short hexadecimal fingerprint; they are not a recovery phrase.
- Linked-transport checks cover independent complete-URL and block vectors, leading-zero preservation, maximum values and first-overflow rejection, alphabet/length/case/percent-escape errors, canonical HTTPS URLs, unsupported versions, and the exact version-40/L bit budget. The complete 2,858-byte envelope fits at the 50-byte prefix limit; a 51-byte prefix is rejected and also fails the underlying QR encoder's capacity check.
- Dense-QR regression fixtures preserve four complete A4/Letter page rasters from Linux CI, including images that exposed false interior finder detection in the generic scanner. The bounded fallback checks known version-40 geometry and retains ZXing's normal matrix validation. Four further deterministic payloads cover fractional module scales and page offsets.
- A separately implemented Python `cryptography`/OpenSSL reference reproduced the complete stored 2,858-byte envelope; JavaScript matched every byte and decrypted every reference message. The reference generator also independently checks the fixture.
- A separate Python standard-library radix43 implementation independently reproduced the complete linked URL and its boundary vectors. It checks malformed block rejection without importing the application codec; CI runs this check too.
- 22 Chromium browser tests: four-message creation and recovery with every password; encrypted text download and pasted recovery; shared capacity meter with UTF-8, near-full/full/overflow, and message-count checks; duplicate errors; identical QR dimensions; keyboard/accessibility/narrow-layout checks; stable password toggles and tab positioning; About scrolling; cancellation of already-queued results; camera track cleanup after frame-capture failure and delayed permission responses; no application storage or external requests in tested flows; password action validation and Enter behavior; closing a populated page without a confirmation dialog; automatic recognition of both pasted text formats and retained corruption checks.
- Recovery IDs match the generated and printed ID before password entry for raw text, written copies, linked URLs, URL fragments, and imported QR images. Replacement changes the ID, malformed imports clear it, and deterministic delayed-digest tests verify that switching views or clearing a fragment prevents an old ID/password form from reappearing. IDs use the shorter `Backup ID:` label and italic styling; the screen uses readable muted gray while print retains black text.
- At 1,280 and 320 pixels, geometry and capacity checks cover all one-to-four message states: a meter follows each text box, every meter shows the same total shared UTF-8 usage and message-count-adjusted maximum, and full/overflow/removal/re-addition/reset stay consistent. Each meter has unique IDs, each textarea references its own label and status, and only one live status announces the shared total. The shortened add-message button fits its bounds. Password fields, show/hide controls, the loaded ID, and the Open backup action do not overlap.
- About presents plain-language backup and offline-recovery guidance, with its technical disclosure closed initially. Browser checks verify disclosure expansion, the visible audit limitation, accessibility, and the stationary About/Close header while the body scrolls.
- Linked UI checks cover linked QR generation without a checkbox, full 2,678-byte single-message creation, independently decoded UI QR content, unchanged raw-text export, a matching six-word ID on screen and in print, and accessibility at 320 pixels. Initial and changed fragments load Decrypt with the password focused, require explicit decryption, clear previous recovered text and passwords, reject malformed data, and remove fragments from the tested browser's address bar without extra requests.
- Clean reader download was byte-identical to the built HTML after entering public test messages/passwords and opening About. The downloaded HTML was reopened in a fresh HTTP context, networking disabled after load, and a fixture recovered.
- A reader downloaded after creating a linked QR, and another downloaded after entering through a recovery fragment, both matched the built HTML exactly. With networking disabled after loading that downloaded reader, the actual generated linked QR image and a pasted link to `gone-paperwarden.invalid` each recovered both independent messages. No requests to the link host, navigation, or application storage occurred.
- Actual A4 and US Letter browser PDFs: full first-page linked QR images were rasterized at both 2,200 and 1,800 pixels and imported through the application; all 115 archival lines were extracted and reconstructed to the exact encrypted bytes; both test passwords recovered exact messages. The printed Backup ID matched the generated envelope. Print surfaces and PDFs were checked for absence of entered public test plaintexts/passwords. Editing inputs invalidated printing/export of the previous result.
- SVG import checks use the exact displayed QR image saved as an SVG, then recover both messages with networking disabled. An empty MIME type with a `.svg` filename also recovers. SVG scripts, event handlers, external stylesheets, external images, and external SVG references remain inactive in the tested passive image context. Malformed images, unsupported MIME claims, images over the pixel cap, and files over the byte cap are rejected.
- Repeat builds were checked for identical HTML and SHA-256 bytes.

## Deliberately not claimed

No real paper was printed/scanned, and no physical camera hardware, aging ink, damaged paper, older-phone performance, or manual screen-reader study was tested. Browser-generated PDF/raster recovery is not a physical print test.

The domain is to be connected later. Automated decoder checks do not establish native phone-camera recognition of a 4,249-character link, successful public hosting, or behavior on every mobile browser. Those checks remain necessary after hosting. The complete saved reader is independent of that hosting.

Password fields retain native masking but are outside HTML submit forms and request autocomplete off. Native browser and extension password-save prompts are outside the page's control; the tests check field configuration and the absence of an app-requested leave-page confirmation, not universal password-manager behavior.

Direct `file://` browser testing was blocked by the available browser tooling's URL policy. HTTP offline-after-load checks do not establish all local-file permissions/behavior. Actual saved-file recovery on Chrome, Firefox, Safari, iOS, and Android remains a release check. In particular, camera access and file opening depend on browser/platform support. The standalone file has no external runtime assets and includes a local-file entry path, but those facts alone are not a substitute for device testing.

The shared-space privacy argument is limited and asymmetric, as described in THREAT_MODEL.md. Tests establish implementation properties and independent interoperability; they do not prove ciphertext indistinguishability, coercion resistance, or protection from a compromised device.

## Reproduction

```sh
npm ci
npm run format:check
npm run check
npm run test:browser
python3 scripts/reference-vector.py --check
python3 scripts/reference-link.py --check
```

The optional Python envelope check requires `cryptography` with Argon2id support (validated here using version 49.0.0); the link check uses only Python's standard library. Browser tests require Chromium and PDF checks require Poppler (`pdftoppm` and `pdftotext`). Set `CHROMIUM_PATH`, `PDFTOPPM_PATH`, and `PDFTOTEXT_PATH` when tools are outside PATH. PDF checks are explicitly skipped if tools are unavailable; inspect the test report before claiming them passed.
