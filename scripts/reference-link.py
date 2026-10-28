"""Independent fixed-block radix-43 link transport reference.

Development verification only; Python standard library, no application imports.
The source envelope and every vector are PUBLIC TEST DATA. This script does not
encrypt messages, navigate URLs, access the network, or execute downloaded code.

Run: python3 scripts/reference-link.py --check
Regenerate deliberately: python3 scripts/reference-link.py --write
"""

import argparse
import hashlib
import json
from pathlib import Path


ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$*+-./:"
BACKUP_BYTES = 2858
BLOCK_BYTES = 21
BLOCK_DIGITS = 31
FULL_BLOCKS = 136
TAIL_BYTES = 2
TAIL_DIGITS = 3
PAYLOAD_CHARACTERS = FULL_BLOCKS * BLOCK_DIGITS + TAIL_DIGITS
URL_PREFIX = "https://paperwarden.com/#PWN1:"


def encode_integer(value, digits):
    """Encode a nonnegative integer, preserving all leading zero digits."""
    if value < 0:
        raise ValueError("Negative integer")
    output = []
    while value:
        value, remainder = divmod(value, len(ALPHABET))
        output.append(ALPHABET[remainder])
    if len(output) > digits:
        raise ValueError("Integer does not fit digit width")
    return "0" * (digits - len(output)) + "".join(reversed(output))


def digit_width(byte_length):
    if byte_length == BLOCK_BYTES:
        return BLOCK_DIGITS
    if byte_length == TAIL_BYTES:
        return TAIL_DIGITS
    raise ValueError("Invalid block byte length")


def encode_block(block):
    return encode_integer(int.from_bytes(block, "big"), digit_width(len(block)))


def decode_block(encoded, byte_length):
    if len(encoded) != digit_width(byte_length):
        raise ValueError("Invalid block digit count")
    number = 0
    for character in encoded:
        if character not in ALPHABET:
            raise ValueError("Invalid radix-43 character")
        number = number * len(ALPHABET) + ALPHABET.index(character)
    if number >= 1 << (8 * byte_length):
        raise ValueError("Block integer overflows byte width")
    return number.to_bytes(byte_length, "big")


def encode_payload(envelope):
    if len(envelope) != BACKUP_BYTES:
        raise ValueError("Invalid envelope length")
    full_bytes = FULL_BLOCKS * BLOCK_BYTES
    chunks = [encode_block(envelope[offset:offset + BLOCK_BYTES])
              for offset in range(0, full_bytes, BLOCK_BYTES)]
    chunks.append(encode_block(envelope[full_bytes:]))
    encoded = "".join(chunks)
    assert len(encoded) == PAYLOAD_CHARACTERS
    return encoded


def decode_payload(encoded):
    if len(encoded) != PAYLOAD_CHARACTERS:
        raise ValueError("Invalid payload length")
    full_digits = FULL_BLOCKS * BLOCK_DIGITS
    chunks = [decode_block(encoded[offset:offset + BLOCK_DIGITS], BLOCK_BYTES)
              for offset in range(0, full_digits, BLOCK_DIGITS)]
    chunks.append(decode_block(encoded[full_digits:], TAIL_BYTES))
    result = b"".join(chunks)
    assert len(result) == BACKUP_BYTES
    return result


def require_rejection(call):
    try:
        call()
    except ValueError:
        return
    raise AssertionError("Malformed transport was accepted")


def vector(root):
    source = json.loads((root / "tests/fixtures/reference.json").read_text(encoding="utf-8"))
    envelope = bytes.fromhex(source["hex"])
    digest = hashlib.sha256(envelope).hexdigest()
    assert digest == source["sha256"]
    assert len(ALPHABET) == len(set(ALPHABET)) == 43
    assert FULL_BLOCKS * BLOCK_BYTES + TAIL_BYTES == BACKUP_BYTES
    assert 43 ** (BLOCK_DIGITS - 1) < 2 ** (8 * BLOCK_BYTES) < 43 ** BLOCK_DIGITS
    assert 43 ** (TAIL_DIGITS - 1) < 2 ** (8 * TAIL_BYTES) < 43 ** TAIL_DIGITS

    encoded = encode_payload(envelope)
    assert decode_payload(encoded) == envelope
    block_cases = [
        ("full-zero", bytes(BLOCK_BYTES)),
        ("full-one", (1).to_bytes(BLOCK_BYTES, "big")),
        ("full-increasing", bytes(range(BLOCK_BYTES))),
        ("full-high-bit", (1 << 167).to_bytes(BLOCK_BYTES, "big")),
        ("full-maximum", b"\xff" * BLOCK_BYTES),
        ("tail-zero", b"\x00\x00"),
        ("tail-one", b"\x00\x01"),
        ("tail-255", b"\x00\xff"),
        ("tail-256", b"\x01\x00"),
        ("tail-maximum", b"\xff\xff"),
    ]
    blocks = []
    for name, block in block_cases:
        digits = encode_block(block)
        assert decode_block(digits, len(block)) == block
        blocks.append({"name": name, "hex": block.hex(), "encoded": digits})

    invalid = []
    for name, byte_length in [("full", BLOCK_BYTES), ("tail", TAIL_BYTES)]:
        digits = digit_width(byte_length)
        for suffix, bad in [
            ("first-overflow", encode_integer(1 << (8 * byte_length), digits)),
            ("maximum-digits", ALPHABET[-1] * digits),
            ("lowercase", "a" + "0" * (digits - 1)),
            ("percent", "%" + "0" * (digits - 1)),
            ("space", " " + "0" * (digits - 1)),
        ]:
            require_rejection(lambda bad=bad, count=byte_length: decode_block(bad, count))
            invalid.append({"name": f"{name}-{suffix}", "byteLength": byte_length,
                            "encoded": bad})

    # Whole-payload checks catch missing leading zeroes and block boundary drift.
    for data in [bytes(BACKUP_BYTES), b"\xff" * BACKUP_BYTES,
                 bytes(index % 256 for index in range(BACKUP_BYTES))]:
        assert decode_payload(encode_payload(data)) == data
    for bad in [encoded[:-1], encoded + "0", encoded + "\n", " " + encoded]:
        require_rejection(lambda bad=bad: decode_payload(bad))
    for bad in invalid:
        if bad["byteLength"] == BLOCK_BYTES:
            malformed = bad["encoded"] + encoded[BLOCK_DIGITS:]
        else:
            malformed = encoded[:-TAIL_DIGITS] + bad["encoded"]
        require_rejection(lambda malformed=malformed: decode_payload(malformed))

    return {
        "warning": "PUBLIC TEST DATA ONLY. This encodes the public envelope in reference.json; never use its messages or passwords for real backups.",
        "reference": "Independent Python standard-library fixed-block radix-43 codec; scripts/reference-link.py",
        "alphabet": ALPHABET,
        "envelopeBytes": BACKUP_BYTES,
        "blockBytes": BLOCK_BYTES,
        "blockDigits": BLOCK_DIGITS,
        "fullBlocks": FULL_BLOCKS,
        "tailBytes": TAIL_BYTES,
        "tailDigits": TAIL_DIGITS,
        "payloadCharacters": PAYLOAD_CHARACTERS,
        "urlPrefix": URL_PREFIX,
        "envelopeSha256": digest,
        "encodedPayload": encoded,
        "url": URL_PREFIX + encoded,
        "blockVectors": blocks,
        "invalidBlockVectors": invalid,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    target = root / "tests/fixtures/link-reference.json"
    expected = vector(root)
    if args.write:
        target.write_text(json.dumps(expected, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote independent public link vector: {target}")
    else:
        assert json.loads(target.read_text(encoding="utf-8")) == expected, "Independent link reference mismatch"
        print("Independent Python link reference and malformed-block checks match.")


if __name__ == "__main__":
    main()
