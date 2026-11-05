# PWN-1 specification

PWN-1 defines one fixed-size encrypted envelope and three representations of it: a QR link, encrypted text, and an archival text copy. All three carry the same 2,858 bytes. This specification fixes their interpretation; changing that interpretation requires a new format identifier and new test vectors. An application's checksum identifies its implementation, independently of the format.

Offsets are zero-based and lengths are bytes unless stated otherwise. `B[a:b]` includes `a` and excludes `b`; `||` concatenates bytes. Integers are unsigned. Quoted strings are exact UTF-8 literals without quotes or a terminating zero. Text is UTF-8, without compression or normalization. Preserve whitespace, newlines, and a leading U+FEFF; reject malformed input Unicode and invalid authenticated UTF-8.

## 1. Envelope

| Offset | Length | Field                                    |
| ------ | ------ | ---------------------------------------- |
| 0      | 4      | ASCII `PWN1` (`50 57 4e 31`)             |
| 4      | 1      | Format version `01`                      |
| 5      | 1      | KDF profile `01`                         |
| 6      | 2      | Reserved, both zero                      |
| 8      | 16     | Fresh random salt                        |
| 24     | 2834   | Circular body: records and random filler |

Thus `B[0:8]` is exactly hexadecimal `50574e3101010000`. Positions in the circular body are `0..2833`, relative to `B[24]`. Define a circular read of `n` bytes at position `s` by:

```
C(s, n)[k] = B[24 + ((s + k) mod 2834)]  for k = 0..n-1
```

A record at position `s` consists of a 30-byte encrypted header followed by encrypted message data:

```
header: nonce[12] || ciphertext[2] || tag[16]
data:   nonce[12] || ciphertext[L] || tag[16]
```

The header's two-byte plaintext is the message's UTF-8 byte length `L`, encoded as uint16LE. The complete record occupies `L+58` bytes. Its data begins at `(s+30) mod 2834`. Every field, including either nonce or tag, may cross the body boundary.

### Writer

Accept one or two nonempty messages. Passwords must be distinct after the normalization in §2. For `n` messages, require:

```
sum(length_i + 58) <= 2834
```

The maximum text length for one message is 2,776 bytes; two messages share 2,718 text bytes. No capacity is reserved for an unused message.

Fill the envelope with CSPRNG bytes, then write the fixed preamble and a fresh independent 16-byte salt.

Before processing messages, choose a private uniform rotation `R` in `0..2833`. Draw two CSPRNG bytes as a big-endian integer `v`; reject `v >= 65182` (`23 × 2834`), otherwise use `R = v mod 2834`. Rotation must be independent of message count, lengths, passwords, and public values.

Pack records consecutively in input order. For message `i` with length `L_i`:

```
s_i = (R + sum(L_j + 58 for j < i)) mod 2834
record_i[k] is stored at B[24 + ((s_i + k) mod 2834)]
```

Encrypt using §2, with fresh independent 12-byte nonces for header and data. Each record wraps at most once. Records cannot overlap. The remaining circular interval retains random filler.

There is no public rotation, message count, order marker, chain pointer, manifest, or whole-envelope authentication tag. Generate a fresh envelope for every backup; do not edit records in place.

## 2. Keys and authentication

Normalize each password to Unicode NFC, then UTF-8 encode without trimming or case folding. Require 1–1,024 encoded bytes. The browser also caps raw input at 4,096 UTF-16 code units; that resource bound does not alter the normalized password bytes.

KDF profile 1 is **Argon2id version 19 (`0x13`)** with memory 65,536 KiB, iterations 3, parallelism 1, output 32 bytes, and the exact salt `B[8:24]`. Use no optional secret or associated data. Costs are fixed.

Apply HKDF-SHA256 extract-and-expand separately to the Argon2 output, using the same salt and these info values:

| Key  | Info                    | Output   |
| ---- | ----------------------- | -------- |
| `KH` | `paperwarden/v1/header` | 32 bytes |
| `KD` | `paperwarden/v1/data`   | 32 bytes |

Use AES-256-GCM with 12-byte nonces and full 16-byte authentication tags. For a record starting at body position `s`, associated data is exactly:

```
header: UTF8("PWN1-H") || B[0:24] || uint16LE(s)
data:   UTF8("PWN1-D") || B[0:24] || uint16LE(s) || H
```

`H` is the original two-byte authenticated header plaintext. Each header tag binds its length to the preamble, salt, and start position. Each data tag also binds the message to that length. Neither tag authenticates another message or filler.

## 3. Recovery

1. Require exactly 2,858 bytes and the exact preamble before password derivation.
2. Derive `KH` and `KD` once for the supplied password.
3. Check every body position `s=0..2833` as a possible header start, with at most 16 header authentication attempts in flight. Let `header=C(s,30)`. Authenticate with `KH`, nonce `header[0:12]`, ciphertext `header[12:14]`, tag `header[14:30]`, and header associated data from §2. Ignore failed header tags. Do not stop after a match and do not check a candidate's length yet.
4. After all 2,834 positions have been checked, require exactly one authenticated two-byte header `H`; retain its start `s`. Only then decode `H` as uint16LE length `L` and require `1 <= L <= 2776`, so `L+58 <= 2834`.
5. Gather `data=C(s+30,L+28)`. Authenticate with `KD`, nonce `data[0:12]`, ciphertext `data[12:12+L]`, tag `data[12+L:L+28]`, and data associated data from §2.
6. Only after authentication, decode the `L` plaintext bytes as strict UTF-8. Preserve the text exactly, including a leading U+FEFF.

Malformed input, invalid lengths, zero or multiple matching headers, failed tags, and invalid UTF-8 must yield no plaintext. Wrong passwords and failures after header authentication use the same opening error. Unsupported public format/profile and resource failures may be reported separately. Do not expose the position or match count. Checking every position is not a claim of browser-wide constant-time execution.

A reader cannot check other records' adjacency or overlap without their passwords. Successful decryption authenticates the selected message only.

## 4. QR link

The default link is:

```
https://paperwarden.com/#PWN1:<4241 radix-42 digits>A
```

The final `A` is framing, not a checksum or encrypted byte. The case-sensitive alphabet is:

```
0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$*+-/:
```

Split the complete envelope into 92 consecutive 31-byte blocks and one final six-byte block. Interpret each block as an unsigned big-endian integer. Encode each full block as exactly 46 radix-42 digits and the final block as exactly nine, most significant digit first, retaining leading zero digits. This gives `92×46+9 = 4241` digits. Append one `A`. Do not encode the entire envelope as one integer, remove the preamble, or compress it.

To decode, require exactly 4,241 alphabet characters followed by `A` after the exact `#PWN1:` marker. Reject full-block values `>= 2^248` and final-block values `>= 2^48`. Restore exactly 31 or six bytes per block, including leading zeros. Do not trim, change case, or percent-decode. Reject whitespace, periods, extra fragments, missing data, and trailing material. Validate the recovered envelope before deriving keys.

### Base URL and QR construction

A complete link requires an absolute HTTPS base URL with a nonempty hostname and visible ASCII characters only. It may contain a path, but no credentials, query, existing fragment, percent sign, backslash, whitespace, or control character. Require exact canonical serialization by the WHATWG URL parser: reject spellings it silently normalizes, such as uppercase hosts, an omitted root slash, explicit default ports, or dot segments. The writer canonicalizes an allowed base URL before encoding it.

The base URL plus `#PWN1:` must occupy at most **35 ASCII bytes**. The default prefix is 30 bytes; its complete link is 4,272 characters. The maximum is 4,277.

Generate a version-40, correction-L QR with two explicit segments: the complete prefix in byte mode, then all 4,242 payload/framing characters in alphanumeric mode. For version 40, these consume:

```
prefix:  4 + 16 + 8×prefix_length bits
payload: 4 + 13 + 2121×11 = 23348 bits
```

The default uses 23,608 of 23,648 available data bits; a 35-byte prefix uses exactly the available bits. The symbol is 177×177 modules. Add a four-module white quiet zone on every side, making 185×185. The app prints this at 150 mm including the quiet zone.

The base URL is outside the envelope authentication. Importing a link into a reader extracts bytes locally; recovery must not depend on contacting its host. Opening a link in a browser is a separate navigation. The period-free alphabet and final letter improve native-camera recognition but do not guarantee it.

## 5. Encrypted-text transport

```
PWN:<RFC 9285 Base45 of the complete envelope>:END
```

Base45 uses alphabet `0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:`. For each byte pair `(a,b)`, set `n=256*a+b` and emit indices `n mod 45`, `floor(n/45) mod 45`, `floor(n/2025)`, in that order. An unpaired final byte uses the first two digits. Preserve spaces and case; they are data.

The 2,858-byte envelope encodes to 4,287 digits, for exactly 4,295 characters including framing. Reject other characters, malformed framing, trailing material, a one-digit final group, three-digit values above 65,535, and two-digit values above 255. Restore the bytes and validate the envelope. Do not trim or URL-decode.

## 6. Archival text copy

Encode the envelope using Base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, most significant bits first, without padding. The last symbol's unused low bit must be zero. Do not substitute ambiguous characters.

```
-----BEGIN PAPERWARDEN BACKUP-----
PWN-1 ARCHIVE
SHA256 <64 lowercase hexadecimal digits over the exact envelope>
001 <40 Base32 characters, grouped in fives> <8 uppercase checksum digits>
...
115 <13 final Base32 characters, grouped in fives> <8 uppercase checksum digits>
-----END PAPERWARDEN BACKUP-----
```

There are exactly 4,573 data characters on 115 numbered lines. For line number `n`, its checksum is the first eight uppercase hexadecimal digits of:

```
SHA256(UTF8("PWN1-LINE:" + decimal(n) + ":" + ungrouped_data))
```

`decimal(n)` has no leading zeros. The displayed line number has three digits. Require consecutive numbers, exact chunk lengths, canonical Base32, every line checksum, the full SHA-256, and the envelope structure.

Bound input to 10,000 characters. Normalize CRLF/CR and form-feed page breaks to line endings, discard blank separator lines, and tolerate surrounding line whitespace and grouping spaces/tabs. Preserve numbered-line boundaries; never join broken content lines. Full SHA256 hex is case-insensitive; data and line checksums are uppercase. A reader accepts either the complete BEGIN/END-delimited block or its body beginning with `PWN-1 ARCHIVE`. Never accept just one marker, nested markers, or extra material within the supplied block.

Markers and checksums add no encrypted bytes. They detect copying errors; an attacker replacing the backup can recompute them.

## 7. Public Backup ID

The Backup ID is a public, six-word shorthand for the first 64 bits of `SHA256(envelope)`. It is not a password, recovery phrase, authentication mechanism, or field inside the envelope.

Interpret the first eight digest bytes as a big-endian integer. Encode it as exactly six base-2048 indices, most significant first with leading zeros. Equivalently, prefix the 64 bits with two zero bits and split into six 11-bit groups. The first index is `0..511`; the others are `0..2047`. Join the indexed words with single ASCII spaces.

The fixed ordered table is [`src/encoding/wordlists/bip39-english.json`](../src/encoding/wordlists/bip39-english.json), from [python-mnemonic commit b57a5ad77a981e743f4167ab2f7927a55c1e82a8](https://github.com/trezor/python-mnemonic/blob/b57a5ad77a981e743f4167ab2f7927a55c1e82a8/src/mnemonic/wordlist/english.txt). Its original UTF-8 text, one word per line with LF endings and a final LF, has SHA-256:

```
2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda
```

Do not translate or reorder it. Only the word table is reused: no BIP39 checksum, seed derivation, or wallet semantics apply. All-zero identifier bits yield `abandon abandon abandon abandon abandon abandon`; all-one bits yield `divide zoo zoo zoo zoo zoo`.

## 8. Conformance vectors

[`tests/fixtures/reference.json`](../tests/fixtures/reference.json) contains public passwords, messages, derived values, and an exact envelope whose first header wraps across the body boundary. Its SHA-256 is:

```
56c53c82f34e207e104705b38a03cf27335f07189712466079835b49e45061ca
```

Its Backup ID indices are `[173,1107,1601,973,452,126]`, yielding `between media sight keen decade average`. [`scripts/reference-vector.py`](../scripts/reference-vector.py) independently reproduces the envelope using Python cryptography/OpenSSL. Deterministic vector randomness and passwords are test data only.

[`tests/fixtures/link-reference.json`](../tests/fixtures/link-reference.json) pins the same envelope's full QR link, leading-zero and maximum-value blocks, and overflow rejection cases. [`scripts/reference-link.py`](../scripts/reference-link.py) checks them using Python's standard library. Implementations must reproduce the valid vectors and reject invalid ones; never regenerate vectors to accommodate an incompatible implementation.
