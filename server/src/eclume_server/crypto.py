"""Encryption of secrets stored in the database (providers' API keys, admin secrets).

AES-256-GCM with a random nonce; the ciphertext is `v1:` + base64(nonce + ciphertext + tag). The key
comes from `ECLUME_ENCRYPTION_KEY` (base64 of 32 bytes) or, without it, is derived from
`ECLUME_SECRET_KEY` by HKDF-SHA256. The plaintext value never goes back through the API.
"""

from __future__ import annotations

import base64
import binascii
import os
from typing import TYPE_CHECKING

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

if TYPE_CHECKING:
    from eclume_server.config import Settings

_PREFIX = "v1:"
_NONCE = 12
_KEY_BYTES = 32


class SecretDecryptError(ValueError):
    """The ciphertext does not open with the current key (key changed or data corrupted)."""


def _key(settings: Settings) -> bytes:
    if settings.encryption_key:
        try:
            key = base64.b64decode(settings.encryption_key, validate=True)
        except binascii.Error as exc:
            msg = "ECLUME_ENCRYPTION_KEY precisa ser base64"
            raise ValueError(msg) from exc
        if len(key) != _KEY_BYTES:
            msg = "ECLUME_ENCRYPTION_KEY precisa ter 32 bytes"
            raise ValueError(msg)
        return key
    hkdf = HKDF(algorithm=hashes.SHA256(), length=_KEY_BYTES, salt=None, info=b"eclume-secrets-v1")
    return hkdf.derive(settings.secret_key.encode())


def encrypt(settings: Settings, plaintext: str) -> str:
    """Encrypt a secret to store in the database."""
    nonce = os.urandom(_NONCE)
    sealed = AESGCM(_key(settings)).encrypt(nonce, plaintext.encode(), None)
    return _PREFIX + base64.b64encode(nonce + sealed).decode()


def decrypt(settings: Settings, token: str) -> str:
    """Open a stored secret; wrong key or corrupted data → `SecretDecryptError`."""
    if not token.startswith(_PREFIX):
        msg = "formato de segredo desconhecido"
        raise SecretDecryptError(msg)
    try:
        raw = base64.b64decode(token[len(_PREFIX) :], validate=True)
        return AESGCM(_key(settings)).decrypt(raw[:_NONCE], raw[_NONCE:], None).decode()
    except (binascii.Error, InvalidTag, ValueError) as exc:
        msg = "o segredo não abre com a chave de cifra atual"
        raise SecretDecryptError(msg) from exc
