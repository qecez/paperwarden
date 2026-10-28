"""Independent PWNX reference vector using Python cryptography/OpenSSL.

Test tooling only; never imported by the application. Requires cryptography
with Argon2id support (tested with 49.0.0). All passwords and deterministic
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
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.argon2 import Argon2id
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


def vector():
    state = 0x5EED

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
        {"text": "A third independent message.",
         "password": "third waterfall forest test password"},
    ]
    preamble = b"PWNX\x01\x01\x00\x00"
    envelope = random(2858)
    salt = bytes(random(16))
    envelope[:8] = preamble
    envelope[8:24] = salt
    slots = list(range(4))
    for index in range(3, 0, -1):
        span = index + 1
        bound = 256 - 256 % span
        while True:
            value = random(1)[0]
            if value < bound:
                break
        chosen = value % span
        slots[index], slots[chosen] = slots[chosen], slots[index]

    offset = 0
    key_vectors = []
    for index, message in enumerate(messages):
        slot = slots[index]
        text = message["text"].encode("utf-8")
        password = unicodedata.normalize("NFC", message["password"]).encode("utf-8")
        master = Argon2id(salt=salt, length=32, iterations=3,
                         lanes=1, memory_cost=65536).derive(password)
        header_key = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt,
                          info=b"paperwarden-next/v1/header").derive(master)
        data_key = HKDF(algorithm=hashes.SHA256(), length=32, salt=salt,
                        info=b"paperwarden-next/v1/data").derive(master)
        header = struct.pack("<HH", offset, len(text))
        header_nonce = bytes(random(12))
        data_nonce = bytes(random(12))
        header_aad = b"PWN1-H" + preamble + salt + bytes([slot])
        data_aad = b"PWN1-D" + preamble + salt + bytes([slot]) + header
        encrypted_header = AESGCM(header_key).encrypt(header_nonce, header, header_aad)
        encrypted_data = AESGCM(data_key).encrypt(data_nonce, text, data_aad)
        header_at = 24 + 32 * slot
        record_at = 152 + offset
        envelope[header_at:header_at + 32] = header_nonce + encrypted_header
        envelope[record_at:record_at + len(text) + 28] = data_nonce + encrypted_data
        offset += len(text) + 28
        key_vectors.append({"slot": slot, "master": master.hex(),
                            "headerKey": header_key.hex(), "dataKey": data_key.hex()})

    assert len(envelope) == 2858
    return {
        "warning": "PUBLIC TEST DATA ONLY. Deterministic LCG seed=0x5eed; never use this randomness or these passwords for real backups.",
        "reference": "Python cryptography/OpenSSL Argon2id, HKDF-SHA256, AES-256-GCM; scripts/reference-vector.py",
        "seed": 0x5EED,
        "messages": messages,
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
        print("Independent Python/OpenSSL reference vector matches.")


if __name__ == "__main__":
    main()
