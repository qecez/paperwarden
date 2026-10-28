# PWN-1 envelope and transport

This document specifies the new Paperwarden prototype. It intentionally does not interpret PWC-1 or earlier prototypes. Test vectors describe this exact schema; any future released schema must be identified unambiguously. The application version, envelope format version, and linked transport version are separate identifiers. The `1` in the linked transport marker `#PWN1:` identifies the encoding below; it is not the displayed application version or a new envelope version.

All offsets are zero-based. Integers are unsigned. Text is UTF-8, without compression. Passwords use NFC normalization; text does not. Preserve every text character, BOM, newline, and leading/trailing space. Reject malformed UTF-16 input and invalid authenticated UTF-8.

## Envelope: exactly 2,858 bytes

| Offset | Length | Meaning                          |
| ------ | ------ | -------------------------------- |
| 0      | 4      | ASCII `PWNX` (`50 57 4e 58`)     |
| 4      | 1      | Format version `01`              |
| 5      | 1      | KDF profile `01`                 |
| 6      | 2      | Reserved zero bytes              |
| 8      | 16     | Fresh random salt                |
| 24     | 128    | Four 32-byte header slots        |
| 152    | 2706   | Shared records and random filler |

A used header slot is `nonce[12] || ciphertext[4] || tag[16]`. Its authenticated plaintext is `offset:uint16LE || length:uint16LE`. Offset is relative to byte 152; length is the plaintext's UTF-8 byte count.

Each data record is `nonce[12] || ciphertext[length] || tag[16]`. Records are packed consecutively in user-entered order, starting at payload offset zero. There is no count, last-record flag, chain pointer, manifest, or whole-envelope authentication tag.

Every unused byte, including unused header slots, comes from the platform CSPRNG. Shuffle all four header positions with Fisher–Yates and unbiased rejection sampling, independently of the number of messages; place successive message headers in that order. Header position is not message order. The whole envelope is freshly generated for each backup; never edit records in place.

## Shared capacity

Each occupied message costs 28 record-overhead bytes, in addition to its text; header overhead is always reserved for all four slots.

| Messages | Maximum combined UTF-8 text bytes |
| -------- | --------------------------------- |
| 1        | 2678                              |
| 2        | 2650                              |
| 3        | 2622                              |
| 4        | 2594                              |

Each message must be nonempty. Passwords must be distinct after NFC normalization. There is no reserved minimum capacity for an imaginary future message. In particular, opening a sufficiently large message can establish that there is no room for another record; this is a deliberate consequence of sharing the entire payload.

The editor repeats a capacity display beneath every message. All displays report the same total UTF-8 usage across all messages against the combined allowance for the current message count.

## Keys and authentication

KDF profile 1 is Argon2id v19 with memory 65,536 KiB, iterations 3, parallelism 1, output 32 bytes, the exact 16-byte file salt, and the NFC-normalized password encoded as UTF-8. Passwords must occupy 1–1,024 normalized UTF-8 bytes; raw input is additionally bounded to 4,096 UTF-16 code units. No adaptive cost changes, optional Argon2 secret, or associated data.

Import the Argon2 output as HKDF material. HKDF-SHA256 uses the same file salt and these distinct UTF-8 info values:

- Header key: `paperwarden-next/v1/header`
- Data key: `paperwarden-next/v1/data`

Each derived key is 32 bytes. AES-256-GCM uses fresh independent 12-byte nonces and full 16-byte tags. Authenticated associated data is exactly:

```
header: UTF8("PWN1-H") || preamble[8] || salt[16] || slot:uint8
data:   UTF8("PWN1-D") || preamble[8] || salt[16] || slot:uint8 || plaintextHeader[4]
```

The tag binds the record to this file, slot, and authenticated coordinates. It deliberately does not bind other headers, other records, or filler.

## Reader

Reject wrong total length, magic, version, profile, or reserved bytes before deriving keys. Derive once for the supplied password and attempt all four header slots; require exactly one successful authentication. Do not expose the slot or number of matches.

Only after header authentication, validate `length > 0`, `length <= 2678`, `offset + length + 28 <= 2706`, and either `offset == 0` or `offset >= 29` (a preceding nonempty record needs at least 29 bytes). A reader cannot validate every record's adjacency without the other passwords.

Authenticate that record before decoding or returning text. Wrong passwords, invalid authenticated coordinates, ambiguous matches, corrupted tags, and invalid UTF-8 yield the same opening error. Unsupported format/profile and resource failures are separate. Check all slots rather than returning after the first success; this is not a browser-wide constant-time claim.

## QR and text transport

Both transports carry the same complete 2,858-byte envelope. The application always generates linked QRs on screen and in print; there is no transport selector. This does not change encryption, message capacity, the envelope format, or the archival written copy. Downloaded encrypted text uses the raw transport, and the reader continues to accept both raw transport and complete links.

Generated QRs use version 40, correction L. The symbol is 177 × 177 modules, with a four-module white quiet zone on each side (185 × 185 total). All backups have the same QR dimensions. The SVG uses integer module coordinates and no external assets. Print size is 150 mm including the quiet zone. A saved SVG QR is an image representation of the transport; it contains no password or plaintext message and can be imported through photo recovery.

### Raw transport

`PWN:` + canonical RFC 9285 Base45 of the complete envelope + `:END`.

2,858 bytes encode to 4,287 Base45 characters, hence 4,295 complete transport characters. Preserve case and spaces exactly. Reject nonalphabet characters, noncanonical final groups, oversize, and trailing material.

The raw transport can be represented in one QR alphanumeric segment. It remains the encrypted-text export format and a supported recovery input; newly generated screen and print QRs use linked transport instead.

### Linked transport

The default complete link is:

```
https://paperwarden.com/#PWN1:<4219 radix-43 characters>
```

Use this alphabet, with the first character representing zero and the last representing 42:

```
0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$*+-./:
```

Split the envelope into 136 consecutive 21-byte blocks, followed by one 2-byte block. Interpret each block as an unsigned big-endian integer. Encode each full block as exactly 31 radix-43 digits, most significant digit first, retaining leading zero digits; encode the final block as exactly three digits. Concatenate without separators. Thus `136 × 21 + 2 = 2858` bytes produce `136 × 31 + 3 = 4219` characters. This is a fixed-block encoding, not one radix conversion of the whole envelope.

The decoder requires exactly 4,219 payload characters from that alphabet. Reject any full-block value greater than or equal to `2^168` and any final-block value greater than or equal to `2^16`; do not truncate excess bits. Reconstruct exactly 21 or two bytes per block, preserving leading zero bytes. The fragment must be exactly `#PWN1:` plus the payload, or 4,225 characters. Reject wrong markers, changed case, whitespace, percent escapes, extra fragments, missing data, and trailing material. Do not trim or percent-decode the payload. Validate the recovered envelope's magic, version, profile, and reserved bytes before password derivation.

For a complete link, require an absolute HTTPS base URL with a nonempty hostname and visible ASCII characters only. The base URL may contain a path but no credentials, query, existing fragment, percent sign, backslash, whitespace, or control characters. Require its exact canonical serialization by the platform URL parser; the complete-link decoder rejects spellings that would be silently normalized, including uppercase hosts, omitted root slashes, explicit default ports, and dot segments. The encoder canonicalizes an allowed base URL before constructing the link. The base URL plus `#PWN1:` must occupy at most 50 ASCII characters; the complete link is bounded to 4,269 characters. The default prefix `https://paperwarden.com/#PWN1:` occupies 30 characters, producing a 4,249-character link.

Use exactly two explicit QR segments:

1. Byte mode: the complete ASCII base URL and `#PWN1:` marker.
2. Alphanumeric mode: the 4,219-character radix-43 payload.

Version 40/L provides 23,648 data bits. The payload consumes `4 + 13 + 2109 × 11 + 6 = 23222` bits, including its mode and count fields. The default 30-byte prefix consumes `4 + 16 + 30 × 8 = 260` bits, for 23,482 bits total before terminator and padding. A 50-byte prefix consumes 420 bits, for 23,642 bits total; a longer prefix cannot fit these two segments. Do not encode the entire URL in byte mode or rely on automatic segmentation.

The base URL is not authenticated by the envelope. Scanning or pasting a complete link into the reader extracts the encrypted bytes locally and never navigates to or requests that URL. Any base URL satisfying the syntax and length rules is accepted, so recovery does not depend on the original host remaining available. Opening a link in a browser is a separate navigation to its host; the reader then consumes the fragment directly without requiring its own hosting address to match the encoded default URL. It attempts to remove the fragment using `history.replaceState`, clears previous recovery state, and validates the new data before showing a password prompt. Address cleanup is best-effort on browsers that restrict history rewriting.

## Public Backup ID

The screen and printout display a six-word Backup ID derived from SHA-256 of the exact 2,858-byte envelope. The same ID appears after generation and after loading the envelope for recovery, before password entry. The hash is calculated after transport and envelope-structure validation, without password derivation. QR scanning, image import, links, raw text, and archival text therefore yield the same ID for the same envelope. It is a public comparison aid, not a password, recovery phrase, encryption key, or part of the serialized envelope. The full printed SHA-256 fingerprint and archival checksums remain unchanged.

Take the first eight digest bytes, equivalently its first 16 hexadecimal characters, as an unsigned big-endian 64-bit integer `N`. Encode `N` in base 2048 as exactly six indices, most significant first, retaining leading zero indices. Equivalently, prefix the 64 bits with two zero bits and split the resulting 66 bits into six consecutive 11-bit groups. The first index is therefore in `0..511`; the other five are in `0..2047`. Map each index to the word at that zero-based position in the fixed table, then join all six words with one ASCII space. All 64 identifier bits are retained; the remaining 192 digest bits are not displayed in the ID.

The ordered 2,048-word English table is vendored in `src/encoding/wordlists/bip39-english.json` from the [official BIP39 reference implementation](https://github.com/trezor/python-mnemonic/blob/b57a5ad77a981e743f4167ab2f7927a55c1e82a8/src/mnemonic/wordlist/english.txt), pinned to commit `b57a5ad77a981e743f4167ab2f7927a55c1e82a8`. Its original UTF-8 representation, one word per line with LF line endings and a final LF, has SHA-256:

```
2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda
```

The MIT notice is preserved in `docs/licenses/BIP39-English-MIT.txt` and embedded in the reader. Only the indexed word table is reused: this encoding does not use BIP39 mnemonic checksums, seed derivation, or wallet functionality. The table and its order are part of the stable identifier specification; do not translate or reorder it.

For the public reference envelope, SHA-256 starts with `91bf3db294e8feda`. The six indices are `[291, 1011, 1753, 595, 1311, 1754]`, producing `caught lazy swamp engine physical swap`. The all-zero 64-bit value produces six occurrences of `abandon`; the all-one value produces `divide zoo zoo zoo zoo zoo`. Unit tests pin the complete table hash, these known values, every single-bit position, and reconstruction of all 64 bits from the words.

## Archival written copy

Crockford Base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, most significant bits first, no padding. Unused bits in the final symbol must be zero. Ambiguous-character substitutions are not allowed.

```
PWN-1 ARCHIVE
SHA256 <64 lowercase hexadecimal digits over the exact envelope>
001 <40 Base32 characters, grouped in fives> <8 uppercase checksum digits>
...
115 <13 final Base32 characters, grouped in fives> <8 uppercase checksum digits>
```

The 2,858-byte envelope produces 4,573 Base32 characters and exactly 115 numbered lines. Each line checksum is the first eight hexadecimal characters of SHA-256 over UTF-8 `PWN1-LINE:<unpadded decimal index>:<ungrouped chunk>`, printed uppercase.

Reader input is bounded to 10,000 characters. Normalize CRLF/CR line endings; tolerate surrounding line whitespace and grouping spaces/tabs. Require sequential line numbers, exact chunk lengths, canonical Base32, every line checksum, the full fingerprint, then the envelope structure. Full SHA256 hexadecimal letter case is tolerated; data and line checksums are uppercase. These checksums detect copying errors, not adversarial replacement.

## Reference verification

`tests/fixtures/reference.json` contains public fictional messages, passwords, the complete envelope, and its SHA-256. A separate Python implementation using cryptography/OpenSSL generates and checks this vector. JavaScript must reproduce the bytes exactly and recover every message. Deterministic vector randomness is never used by the browser worker.

`tests/fixtures/link-reference.json` encodes that same envelope using an independent Python standard-library implementation in `scripts/reference-link.py`. It records the complete radix-43 payload and default URL, valid extreme block values, and malformed blocks including the first overflowing value for each block width. JavaScript must reproduce the payload and URL exactly, recover the original envelope bytes, and reject noncanonical block values. The link codec adds no cryptographic protection.
