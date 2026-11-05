# Threat model

Paperwarden protects small, password-encrypted messages stored in a fixed-size backup. It creates backups with one or two messages and aims to conceal a fitting, undisclosed message when one password is revealed. These are separate claims: authenticated encryption does not by itself establish plausible deniability.

The arguments below state design assumptions and limits, not a formal proof.

## Attacker and assumptions

The attacker knows the format and software and holds an exact copy of the backup. They can perform unlimited offline password guesses, obtain a message password, and supply a modified backup for recovery. They may compare known copies. There is no account, password reset, or rate limit.

The file-level claims assume:

- Trustworthy creation and recovery devices, browsers, app code, and random-number generation.
- Strong, independently chosen passwords for messages that remain secret.
- The security of Argon2id, HKDF-SHA256, and AES-256-GCM under the specified parameters.
- For message concealment, unknown-key header and record bytes that cannot be distinguished from random filler. Ordinary AEAD confidentiality and authenticity alone do not establish this stronger property.

Observation of creation or recovery, device compromise, and coercion are outside the file-level claim. A person demanding passwords may have expectations or evidence unrelated to the encrypted bytes.

## What the backup reveals

Every envelope is 2,858 bytes, with a 24-byte public prefix and a 2,834-byte circular body. The public preamble identifies PWN-1 and its fixed KDF profile. The salt is public. There is no public message count, occupancy bitmap, rotation, or ordering field. Linked QRs use the same version, correction level, and dimensions; text and archival exports carry the same envelope.

A successful password discloses one message, its exact UTF-8 byte length, and its start position in the circular body. The interface displays only the message, but an attacker with the password can recover all of that metadata. Authentication failure at a candidate start does not distinguish filler from a header encrypted under a different password.

### One disclosed message

Records occupy one consecutive circular run in input order. A fresh private start `R` is uniform over the 2,834-byte body and independent of message count and lengths. For message `i`:

```
start_i = (R + preceding_record_bytes_i) mod 2834
```

Adding a fixed preceding length to uniform `R` leaves the start uniform. One start alone therefore does not reveal creation order or the amount of earlier occupied space. The encrypted header contains only its own message's length, with no reference to another record.

The concealment goal compares a one-message backup with a two-message backup containing the same disclosed content and a fitting undisclosed message. Subject to the assumptions above, the remaining bytes should not distinguish the undisclosed record from filler. Uniform starts establish only the placement property; they do not prove the complete cryptographic indistinguishability claim. Revealing both passwords reveals both messages.

### Capacity and password constraints

A record containing `L` text bytes occupies `L+58` bytes; another nonempty record needs at least 59. A disclosed message of 2,718 bytes or more leaves no room for another message. At 2,717 bytes, only a one-byte second message fits. Smaller messages can rule out a suspected message of a particular length.

Changing a word or suffix in a disclosed password does not make the other password independent. Duplicate checks reject exact reuse after NFC normalization but cannot establish the strength or independence of custom passwords. Message content may itself identify other messages.

### Password generation

The [generator](../src/app/passphrase.ts) selects eight words independently, with replacement, from a table of 2,048 distinct words. It fills eight unsigned 16-bit values with `crypto.getRandomValues` and maps each to an index with `value & 0x7ff`. Each index has exactly 32 preimages, so this mapping introduces no bias. Word order is preserved and repetitions are allowed.

Under the platform CSPRNG assumption, there are `2048^8 = 2^88` equally likely outputs: 88 bits of entropy. This describes a fresh, unfiltered generator output, not a cracking-time estimate or a guarantee about the device. User edits or selection by personal preference can change the distribution. Argon2id increases the cost of each guess; it does not add password entropy.

Only the BIP39 word table is reused. Generated passwords have no BIP39 checksum or wallet-seed semantics. Each generation uses fresh randomness, without a master password or another message's password; failure of the random source stops generation.

The creation interface requires at least seven Unicode code points after NFC normalization. This is a length check, not a strength estimate. Recovery accepts the format's full password range without imposing that creation minimum. The four-word Backup ID is a public label for the encrypted backup, not a generated password.

## Integrity: a message is not the whole backup

Each header tag authenticates its own message length, start position, salt, and preamble. Its data tag authenticates the message with those same values. Neither authenticates another message or filler.

Each opening makes 2,834 header authentication attempts. Tags are 128 bits, but aggregate forgery bounds account for all verification attempts and processed blocks. A matching header alone never releases plaintext: the data tag must also authenticate.

An attacker can damage an undisclosed region while a known message remains readable. With a known password, they can retain or recreate that message and put an attacker-chosen message under another password into a replacement envelope where capacity permits. Successful opening of the known message does not establish that the rest of the backup is original.

This requires changing the backup. No message can be inserted into unchanged QR bytes. Compare against an independently trusted original or its full SHA-256 to detect replacement. A checksum supplied alongside a replacement can be recomputed by the attacker; it is not a signature.

The interface and printout show a four-word abbreviation of the canonical six-word Backup ID defined by PWN-1. Taking its first four words retains the leading 42 SHA-256 bits (9 + 11 + 11 + 11). The abbreviation is public, reveals no password or count, and is useful for comparing copies. Collisions are possible. Matching words do not establish authenticity or full equality, and showing the ID after structural validation does not authenticate a message. The full printed checksum and archival line checksums remain public error-detection aids.

## Links and hosted code

A generated QR contains an HTTPS address and the entire encrypted envelope after `#PWN1:`. It contains no password or plaintext. Browsers omit the fragment from the HTTP request, but the loaded page can read it and any password entered there. The host receives the ordinary page request and network metadata. HTTPS does not protect against compromised hosted code or a replaced QR pointing to a malicious site.

Importing a QR image, scanning within an already-open reader, or pasting a link validates and extracts the encrypted bytes locally. It neither contacts nor navigates to the encoded host. The host is unauthenticated metadata; accepting another syntactically valid host allows recovery after the original website disappears. It does not certify that host.

A phone camera may offer Search instead of opening the URL. Searching sends the encrypted backup to the provider; fragment privacy does not apply. The period-free encoding addresses observed recognition failures, but cannot control every camera. Use import into a trusted reader when recognition fails.

The app tries to remove a recovery fragment with `history.replaceState` before populating controls. This is best-effort and cannot erase scanner logs, synchronized history, extensions, screenshots, or other retained copies.

## Browser and input boundaries

The [publication workflow](HOSTING.md#publication-contract) separates testing, immutable release publication, deployment, and mirroring. Production verifies the published files before upload, but Cloudflare does not enforce their provenance. A hosting-account compromise or owner action can still replace the reader or target selected visitors; public release evidence cannot prove what every visitor received.

The release embeds its runtime dependencies. Its CSP denies network connections and restricts scripts and styles to embedded hashes; Blob workers and WebAssembly are permitted. There is no analytics, persistent application storage, or remote loader. External links navigate only on user action. These controls reduce exposure in authentic code; they do not make replaced code trustworthy.

The footer's **download the app** action saves the pristine release HTML captured before loading a recovery fragment or changing the interface. It does not serialize live forms, recovered text, or generated backups. Editing message inputs invalidates all associated display, print, and export state. Imports publish the validated bytes, ID, and password prompt together only while their operation remains current; stale asynchronous results are discarded.

The footer's saved-copy wording reflects only `location.protocol === "file:"`, not network connectivity, authenticity, or safety. **verify it** opens a local guide without making a network request. The **Build** label and source/checksum links derive from a hash of the initial canonical HTML serialization used for downloads, not the file on disk. Parsing may normalize modified file bytes. A compromised app can falsify its wording, build label, and links. Verify the actual file with an external checksum command and a trusted published digest.

Public envelope fields are validated before expensive derivation. Creation count, text/password lengths, transports, archive text, image file size, and scan dimensions are bounded. Each recovery derives once and checks all 2,834 possible header starts, with at most 16 authentication attempts in flight. It requires exactly one authenticated header before checking its length. Crypto runs in an operation worker, terminated on completion, cancellation, error, or after 120 seconds.

SVG imports use a passive `Image` and canvas, never DOM insertion, frames, or objects. Isolation relies on the browser's [secure SVG image processing mode](https://www.w3.org/TR/SVG/conform.html#secure-animated-mode), not textual sanitization. Image imports are capped at 20 MiB and 40 million intrinsic pixels, with a scan surface no larger than 2,400 pixels per axis. A browser may allocate or decode data before dimensions are available; these limits do not eliminate decoder vulnerabilities or resource exhaustion.

Mutable sensitive buffers are overwritten where practical. JavaScript strings, CryptoKey internals, browser memory, autofill, crash dumps, and operating-system artifacts cannot be reliably erased. Clearing the interface or terminating a worker is not secure deletion. Password generators and masked fields also cannot prevent screenshots or shoulder surfing.

Creation time is not hidden: creating `n` messages performs `n` derivations and then opens all `n` as a self-check, for `2n` Argon2id derivations. Recovery checks every possible header start, but the browser, rendering, and complete operation are not constant-time. Observations of the interface, timing, or resource use can reveal message count.

Print output contains encrypted bytes and public recovery instructions, not plaintext or passwords. Printing, image decoding, camera permissions, and file handling still depend on the browser and operating system. Error correction L maximizes the selected QR capacity with limited damage tolerance; real prints and intended recovery devices must be tested.

## Evidence and remaining work

The [validation document](VALIDATION.md) records independent vectors, adversarial mutations, browser lifecycle checks, offline recovery, and print tests. Those checks establish specific implementation properties and interoperability, not deniability or coercion resistance.

The design and implementation have not had an independent security audit. Further work includes independent cryptographic and implementation review, broader local-file browser testing, and physical printer/phone testing. Preserve the frozen specification, vectors, verified reader, and release provenance so recovery does not depend on this repository or website remaining online.
