"""Independent PWN-1 reference vector using Python cryptography/OpenSSL.

Test tooling only; never imported by the application. Requires cryptography
with Argon2id support (tested with 50.0.2). All passwords and deterministic
randomness below are PUBLIC TEST DATA, unsuitable for real secrets.

Run: python3 scripts/reference-vector.py --check
Regenerate deliberately: python3 scripts/reference-vector.py --write
"""

import argparse
import hashlib
import json
from pathlib import Path
import struct
import unicodedata

from cryptography.hazmat.primitives import hashes
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.argon2 import Argon2id
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


def recover(envelope, password):
    """Separate reader following the printed recovery reference; no app imports."""
    if len(envelope) != 2858 or envelope[:8] != bytes.fromhex("50574e3101010000"):
        raise ValueError("Invalid envelope")
    normalized = unicodedata.normalize("NFC", password).encode("utf-8")
    if not 1 <= len(normalized) <= 1024:
        raise ValueError("Invalid password length")
    salt = envelope[8:24]
    master = Argon2id(salt=salt, length=32, iterations=3,
                     lanes=1, memory_cost=65536).derive(normalized)
    keys = [HKDF(algorithm=hashes.SHA256(), length=32, salt=salt,
                 info=b"paperwarden/v1/" + label).derive(master)
            for label in (b"header", b"data")]

    def circular(start, length):
        return bytes(envelope[24 + (start + k) % 2834] for k in range(length))

    matches = []
    for position in range(2834):
        header = circular(position, 30)
        try:
            length_bytes = AESGCM(keys[0]).decrypt(
                header[:12], header[12:],
                b"PWN1-H" + envelope[:24] + struct.pack("<H", position))
            matches.append((position, length_bytes))
        except InvalidTag:
            pass
    if len(matches) != 1:
        raise ValueError("Cannot open backup")
    position, length_bytes = matches[0]
    length, = struct.unpack("<H", length_bytes)
    if not 1 <= length <= 2776:
        raise ValueError("Cannot open backup")
    data = circular(position + 30, length + 28)
    try:
        text = AESGCM(keys[1]).decrypt(
            data[:12], data[12:],
            b"PWN1-D" + envelope[:24] + struct.pack("<H", position) + length_bytes)
        return text.decode("utf-8", errors="strict")
    except (InvalidTag, UnicodeDecodeError) as error:
        raise ValueError("Cannot open backup") from error


def vector():
    state = 0x7c7

    def random(length):
        nonlocal state
        result = bytearray(length)
        for index in range(length):
            state = (state * 1664525 + 1013904223) & 0xFFFFFFFF
            result[index] = state >> 24
        return result

    messages = [
        {"text": "Public main message 🌿\n\ufeffCafé — 東京  ",
         "password": " cafe\u0301 river moon 2026 "},
        {"text": "A separate message.\n保持",
         "password": "another separate test password"},
    ]
    preamble = b"PWN1\x01\x01\x00\x00"
    envelope = random(2858)
    salt = bytes(random(16))
    envelope[:8] = preamble
    envelope[8:24] = salt
    while True:
        candidate = int.from_bytes(random(2), "big")
        if candidate < 65182:
            break
    rotation = candidate % 2834
    assert rotation == 2832 and rotation + 12 > 2834, "Reference nonce must wrap"
    position = rotation
    key_vectors = []
    for message in messages:
        text = message["text"].encode("utf-8")
        password = unicodedata.normalize("NFC", message["password"]).encode("utf-8")
        master = Argon2id(salt=salt, length=32, iterations=3,
                         lanes=1, memory_cost=65536).derive(password)
        header_key = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt,
                          info=b"paperwarden/v1/header").derive(master)
        data_key = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt,
                        info=b"paperwarden/v1/data").derive(master)
        length_bytes = struct.pack("<H", len(text))
        position_bytes = struct.pack("<H", position)
        header_nonce = bytes(random(12))
        data_nonce = bytes(random(12))
        header_aad = b"PWN1-H" + preamble + salt + position_bytes
        data_aad = b"PWN1-D" + preamble + salt + position_bytes + length_bytes
        encrypted_header = AESGCM(header_key).encrypt(header_nonce, length_bytes, header_aad)
        encrypted_data = AESGCM(data_key).encrypt(data_nonce, text, data_aad)
        record = header_nonce + encrypted_header + data_nonce + encrypted_data
        for k, byte in enumerate(record):
            envelope[24 + (position + k) % 2834] = byte
        key_vectors.append({"position": position, "length": len(text), "master": master.hex(),
                            "headerKey": header_key.hex(), "dataKey": data_key.hex()})
        position = (position + len(text) + 58) % 2834

    assert len(envelope) == 2858
    return {
        "warning": "PUBLIC TEST DATA ONLY. Deterministic LCG seed=0x7c7; never use this randomness or these passwords for real backups.",
        "reference": "Python cryptography/OpenSSL Argon2id, HKDF-SHA256, AES-256-GCM; scripts/reference-vector.py",
        "seed": 0x7c7,
        "messages": messages,
        "rotation": rotation,
        "keys": key_vectors,
        "hex": envelope.hex(),
        "sha256": hashlib.sha256(envelope).hexdigest(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    args = parser.parse_args()
    target = Path(__file__).resolve().parents[1] / "tests/fixtures/reference.json"
    expected = vector()
    if args.write:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(expected, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote independent public vector: {target}")
    else:
        assert json.loads(target.read_text(encoding="utf-8")) == expected, "Independent reference vector mismatch"
        for message in expected["messages"]:
            assert recover(bytes.fromhex(expected["hex"]), message["password"]) == message["text"]
        try:
            recover(bytes.fromhex(expected["hex"]), "a wrong public test password")
        except ValueError:
            pass
        else:
            raise AssertionError("Wrong password must fail")
        print("Independent Python/OpenSSL reference vector and recovery match.")


if __name__ == "__main__":
    main()
