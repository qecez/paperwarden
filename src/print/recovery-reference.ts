/** Self-contained PWN-1 recovery instructions; quoted literals are exact UTF-8. */
export const RECOVERY_TITLE = "Technical recovery reference";
export const RECOVERY_SECTIONS: readonly [string, readonly string[]][] = [
  [
    "Scope and notation",
    [
      "Recover one message from this backup and its password using established cryptographic libraries. Keep secrets local. Lengths and zero-based offsets are bytes. B[a:b] excludes b; || concatenates bytes; uint16LE is two-byte unsigned little-endian. Quoted strings exclude quotes and any terminating zero.",
    ],
  ],
  [
    "1. Decode the text copy",
    [
      'Ignore blank lines and page breaks, but preserve numbered-line boundaries. Between the BEGIN/END markers require "PWN-1 ARCHIVE", "SHA256" plus 64 hex digits, then lines 001–115 in order. Each line has its number, grouped data, and an 8-digit uppercase hex checksum.',
      'Remove spaces/tabs from data groups only: 40 characters per line, except line 115 has 13. For line n, check the first 8 uppercase hex digits of SHA256(UTF8("PWN1-LINE:" + decimal(n) + ":" + data)); decimal(n) has no leading zeros.',
      'Join the 4,573 data characters. Decode 5-bit digits using "0123456789ABCDEFGHJKMNPQRSTVWXYZ" (indices 0–31), most significant bits first. Reject other characters and a nonzero final unused bit. Require 2,858 decoded bytes B and verify SHA256(B) against all 64 printed hex digits.',
    ],
  ],
  [
    "Alternative: decode the QR link",
    [
      'After "#PWN1:", require 4,241 digits followed by one final framing letter "A". Remove only that A. Alphabet: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$*+-/:" (indices 0–41). Read most significant digits first: 92 blocks of 46 digits, each an unsigned 31-byte big-endian integer, then 9 digits as 6 bytes. Preserve leading zero bytes; reject values exceeding these widths. Join to obtain B. Do not change case, punctuation, or percent-decode. The URL host is unnecessary.',
    ],
  ],
  [
    "2. Validate bytes and derive keys",
    [
      "Require length(B) = 2858 and B[0:8] = hex 50574e3101010000. Salt S = B[8:24]. Circular body = B[24:2858]; define C(s,n)[k] = B[24 + ((s+k) mod 2834)] for k = 0..n-1. Normalize the password to Unicode NFC, then UTF-8 without trimming; require 1–1,024 bytes.",
      "Argon2id: version 19 (0x13), salt S, memory 65,536 KiB, iterations 3, parallelism 1, output M of 32 bytes; no secret or associated data.",
      'HKDF-SHA256 extract-and-expand: input M, salt S, output 32 bytes independently for info "paperwarden/v1/header" (key KH) and "paperwarden/v1/data" (key KD). Derive these keys once per password.',
    ],
  ],
  [
    "3. Authenticate one header",
    [
      'Check all 2,834 starts s = 0..2833, at most 16 attempts in flight. Let T = C(s,30). AES-256-GCM: key KH; nonce T[0:12]; ciphertext T[12:14]; tag T[14:30]; associated data UTF8("PWN1-H") || B[0:24] || uint16LE(s). Ignore failed tags. Finish all starts before requiring exactly one authenticated 2-byte header H; retain its start s.',
      "Only after that uniqueness check, decode H as uint16LE text length L. Require 1 <= L <= 2776, so the complete header and data occupy L+58 <= 2834 bytes.",
    ],
  ],
  [
    "4. Authenticate the circular record",
    [
      'Gather D = C(s+30,L+28). AES-256-GCM: key KD; nonce D[0:12]; ciphertext D[12:12+L]; tag D[12+L:L+28]; associated data UTF8("PWN1-D") || B[0:24] || uint16LE(s) || H. H is the original two plaintext header bytes; s is the header start.',
      "Authenticate before releasing text. Decode exactly L plaintext bytes as strict UTF-8. Preserve whitespace and leading U+FEFF (BOM); do not normalize recovered text.",
    ],
  ],
  [
    "Failure rules",
    [
      "Malformed input, failed checks, zero/multiple matching headers, a failed data tag, or invalid UTF-8 must yield no plaintext. Use one generic opening error; do not reveal matching positions or counts. Never guess missing bytes or relax authentication. Success authenticates only that message; there is no global tag for the rest of the backup.",
    ],
  ],
];
