# Threat model and review limits

## Intended protection

The attacker can read and modify the paper/QR/encrypted file, knows the full format and software, can attempt offline password guesses, and may learn one or several message passwords. The creation and recovery device and original software are assumed trustworthy. Password quality remains essential; there is no account, reset, or server-side rate limit.

Each message has independent password-derived keys. Authentication must succeed before metadata is trusted or text is released. Public metadata fixes the work and memory bounds. One password attempt performs one Argon2id derivation and four bounded header checks. The worker is terminated on completion, cancellation, error, or after 120 seconds.

## Asymmetric additional-message privacy

Every file reserves four header slots and has the same length, public preamble, QR version, correction level, and QR dimensions. Every newly generated QR uses the same linked transport; there is no per-backup transport choice or saved preference. Raw encrypted-text exports and archival text represent the same 2,858-byte envelope and do not change its shared capacity. Unused slots and payload are random; no count or empty marker exists. The directory is randomly permuted independently of message count. A successful password opens only its matching message.

Records are sequential in creation order. Revealing a record discloses its offset and length. A nonzero offset establishes that some earlier occupied space exists and can bound the amount of earlier data. Given multiple passwords, gaps between their records can disclose intervening occupied space. This direction of leakage is accepted; the first message's offset is always zero.

A record's header and tags contain no explicit metadata about later messages. Under the password-KDF and AEAD pseudorandomness assumptions, a disclosed prefix should not distinguish fitting encrypted suffixes from unused random filler. This is a limited informal construction argument, not a formal proof or external audit. In particular, random-looking data and round-trip tests do not prove deniability.

All messages share finite capacity without a reserve. Disclosed lengths, occupied regions, and the four-slot limit can rule out some possible remaining messages. A full single-message envelope leaves no room for another message. Weak hidden passwords can be guessed independently. Revealing all occupied passwords is not evidence of the absence of another fitting message, but revealing enough capacity or all four valid slots can establish the limit.

Do not promise coercion resistance. Expectations of the person demanding passwords, creation observations, compromised devices, browser extensions, screenshots, prior exports, and device/OS artifacts are outside the limited file-level goal. Each new backup receives fresh salt, nonces, filler, and header placement; the app does not edit old envelopes in place.

## Integrity and availability

A message's AEAD protects its own header and data. It does not authenticate other slots or filler. An attacker can destroy a different message while leaving a disclosed message readable. A global tag is intentionally absent because it would couple independently disclosed messages. Printed fingerprints and archival checksums are public error-detection aids, not signatures or proof of who published a reader.

The six-word Backup ID represents only the first 64 SHA-256 bits, preserving the same information as a 16-hexadecimal-character shorthand. It is shown after generation, on paper, and when the encrypted backup is loaded before password entry. Anyone holding the encrypted envelope can calculate it; it discloses no password or message count. Different envelopes can share an ID; matching words do not prove complete equality or authenticity. In particular, displaying an ID after structural validation does not authenticate any encrypted message. The full printed SHA-256 fingerprint remains available. The fixed public word table is borrowed from BIP39, but the ID is not a BIP39 mnemonic, password, or recovery phrase and cannot recover the backup. Its word list is bundled, with no runtime network request.

Malformed structure is rejected before expensive KDF work. Message count, input text/passwords, transport length, archival text, and image dimensions/file sizes are bounded. Images may still be allocated by the browser before their dimensions can be checked. QR error correction L offers the chosen capacity/damage-tolerance tradeoff; actual print and camera recovery needs physical testing.

QR image import accepts PNG, JPEG, WebP, BMP, and SVG. SVG is recognized by `image/svg+xml`, or by a `.svg` filename when the browser supplies an empty MIME type; that fallback receives an explicit SVG Blob type. The app passes the Blob URL to an `Image` and draws it to a canvas. It never inserts imported SVG markup into the page, a frame, or an object. Isolation relies on the browser's [secure SVG image processing mode](https://www.w3.org/TR/SVG/conform.html#secure-animated-mode), which disables scripts, event handlers, interaction, and external network references; this is not textual sanitization. Imports are capped at 20 MiB and 40 million intrinsic pixels, with a scan surface no larger than 2,400 pixels on either axis. SVGs are rasterized at that scan resolution, including viewBox-only images. These bounds do not guarantee protection from browser decoder allocation or resource exhaustion before image dimensions are known.

## Recovery links

Every generated QR contains an HTTPS reader address and the entire encrypted envelope in a `#PWN1:` fragment. No password or plaintext is included. The fragment is excluded from the HTTP request when a browser opens the link, but the destination still receives the ordinary page request and its network metadata. The loaded page's JavaScript can read the fragment and any password entered there. An authentic, trustworthy reader remains a requirement: HTTPS and a familiar domain do not protect against compromised hosted code or a replaced QR directing someone to a different site.

The URL's host is unauthenticated metadata, outside the envelope's AEAD. When a link is scanned, imported as a photo or SVG image, or pasted into an already-open reader, the app validates and extracts its bytes locally without contacting or navigating to that host. It accepts other canonical HTTPS hosts satisfying the bounded transport syntax so that a saved reader can recover backups even if the printed domain is unavailable. This import behavior does not certify the host's identity. The offline reader, raw encrypted-text export, and archival written copy remain usable independently of the linked website.

On initial load or a new recovery fragment, the app attempts to remove the fragment with `history.replaceState` before populating recovery controls. It clears any previous recovered text, password, and loaded backup before validating the new data; malformed input does not start password derivation. History rewriting is best-effort: restrictive local-file browsers may leave the fragment visible. Even successful address-bar cleanup cannot erase copies already retained in scanner logs, browser history or synchronization, extensions, screenshots, or other device artifacts. The app does not store the payload in history state or persistent storage.

## Runtime boundaries

The release embeds its dependencies. CSP denies network connections and limits executable script/style content to embedded hashes; Blob workers and WebAssembly are explicitly allowed. The app uses no persistent storage, remote runtime loader, or analytics. GitHub links navigate only when clicked.

Save offline reader captures the canonical pristine release before fragment loading or UI mutations. It does not serialize entered messages, passwords, imported links, or generated backups. Tests compare saved bytes after secret entry and About/license display. Workers isolate and release operation state; mutable sensitive buffers are overwritten where practical. JavaScript strings, CryptoKey internals, browser memory, autofill, crash dumps, and OS storage cannot be reliably erased by this app.

Recovery imports validate and hash the encrypted envelope within one cancellable operation. The loaded bytes, Backup ID, and password prompt are published together only if that operation is still current. Starting another import clears the previous ID immediately; a cancelled or replaced hash result cannot restore it beside a different backup.

Print DOM is built only from encrypted bytes and public instructions, committed atomically, and cleared when inputs become stale. Screen and print QRs use the same linked transport and six-word Backup ID for the generated envelope. The full printed SHA-256 fingerprint and archival line checksums remain available. Native printing, image decoding, and file handling remain browser/OS responsibilities.

## Release criteria

Automated checks include independent-implementation vectors for encryption and linked transport, malformed authenticated inputs, all message counts and capacity boundaries, mutation of separate records, UTF-8 preservation, maximum-density QR decoding, archival reconstruction, clean reader exports, and UI lifecycle/accessibility checks. See VALIDATION.md for what was actually run.

Before treating this as a stable archival product: obtain independent cryptographic/implementation review, test common desktop/mobile browsers opening the actual saved file without network, and test real printers/phone cameras, including native-camera recognition of the complete linked QR. Dense QR decoding in automated tests does not establish every phone's URL recognition or browser behavior. Freeze the released schema and publish trustworthy provenance only when ready to support real backups.
