# Public recovery example

This is **public test data**, not a backup template. Never reuse its passwords,
salt, nonces, or deterministic random generator for real messages.

Use the `hex` field of [`tests/fixtures/reference.json`](../tests/fixtures/reference.json)
as the complete 2,858-byte envelope `B`. Its SHA-256 is:

```text
56c53c82f34e207e104705b38a03cf27335f07189712466079835b49e45061ca
```

The following checkpoints recover its first message using the printed procedure
and [PWN-1 specification](FORMAT.md). The second message and its keys are in the
same fixture; the [link fixture](../tests/fixtures/link-reference.json) contains
its QR representation. Keep these fixtures unchanged when testing a new reader.

## Password and keys

The password below is written as a JSON string so its spaces and combining
character are unambiguous. Normalize to NFC, preserving both outer spaces:

```text
Input:       " cafe\u0301 river moon 2026 "
After NFC:   " caf\u00e9 river moon 2026 "
UTF-8 hex:   20636166c3a9207269766572206d6f6f6e203230323620
Salt B[8:24]: 5bfffbdbdf291609524cba1897494a1e
```

Argon2id v19, memory 65,536 KiB, three iterations, one lane, 32-byte output gives
`M` below. Independently apply HKDF-SHA256 extract-and-expand with that salt and
the exact UTF-8 info strings `paperwarden/v1/header` and `paperwarden/v1/data`:

```text
M:  69946cb17c274146125086e417f9ab6b04beffd8c6b9362bbfa0179b9114ae77
KH: 726aea20f627edd0a825ff8248b1762871615c649852ab60e9a723ba3f11260c
KD: e0a8bb2a0b8fbe44f0b3281a2203be8c5754e2957a44f531370880d153456760
```

## Wrapped header and record

Check all 2,834 body positions with at most 16 header authentication attempts in
flight. With `KH`, only start `s=2832` authenticates. Its 30-byte header is
`B[2856:2858]` followed by `B[24:52]`. Finish the entire search and require exactly
one authenticated header before checking its length. All values below are
hexadecimal bytes:

```text
Header nonce:      49f5d7e489b2a071011b7140
Header ciphertext: 3837
Header tag:        3977e135df5fb0cc398423867a134ebb
Header AAD:        50574e312d4850574e31010100005bfffbdbdf291609524cba1897494a1e100b
Header plaintext:  2e00
```

The header's little-endian integer is text length `46`, within the required range
`1..2776`. The encrypted data begins at body position `(2832+30) mod 2834 = 28`.
Gather its `74` bytes as `B[52:126]`. Authenticate with `KD` and AAD that includes
the header start `2832` encoded as uint16LE (`100b`), followed by the exact
authenticated length bytes `2e00`:

```text
Data nonce:      28da9f83cf7e6a83ee80f3af
Data ciphertext: 37abc11ebfb8a06f8c78e869837cd042657e08b6b4a57240524c26c94b5eeae6e7d481bfe09e48410424f195203f
Data tag:        c8ece48c9acc7ca1bc6d41118db0842f
Data AAD:        50574e312d4450574e31010100005bfffbdbdf291609524cba1897494a1e100b2e00
```

The authenticated 46-byte plaintext is:

```text
5075626c6963206d61696e206d65737361676520f09f8cbf0aefbbbf436166c3a920e2809420e69db1e4baac2020
```

Decoded as strict UTF-8, it equals this JSON string. Preserve the newline, U+FEFF,
and both final spaces:

```json
"Public main message 🌿\n\ufeffCafé — 東京  "
```

[`scripts/reference-vector.py`](../scripts/reference-vector.py) independently
checks the full vector and recovery using Python cryptography/OpenSSL:

```sh
python3 scripts/reference-vector.py --check
```

Also test rejection: a wrong password, an altered authenticated header or record,
invalid lengths, multiple matching headers, and invalid authenticated UTF-8
must release no plaintext. This example does not replace those negative tests.
