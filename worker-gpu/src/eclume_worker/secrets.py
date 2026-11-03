"""Open the secrets the server sends encrypted in the job `options` (today, `hf_token_encrypted`).

Same format as `eclume_server.crypto`, described in the job contract: `v1:` + base64(12-byte
nonce + AES-256-GCM ciphertext + tag). The key is `ECLUME_ENCRYPTION_KEY` (base64 of 32 bytes) or,
without it, the HKDF-SHA256 of `ECLUME_SECRET_KEY` with `info=eclume-secrets-v1` — the same as the server's.
"""

from __future__ import annotations

import base64
import binascii

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

_PREFIX = "v1:"
_NONCE = 12
_KEY_BYTES = 32


class SecretError(ValueError):
    """The secret does not open: no key on the worker, a key different from the server's, or corrupted data."""


def _key(encryption_key: str | None, secret_key: str | None) -> bytes:
    if encryption_key:
        try:
            key = base64.b64decode(encryption_key, validate=True)
        except binascii.Error as exc:
            msg = "ECLUME_ENCRYPTION_KEY precisa ser base64"
            raise SecretError(msg) from exc
        if len(key) != _KEY_BYTES:
            msg = "ECLUME_ENCRYPTION_KEY precisa ter 32 bytes"
            raise SecretError(msg)
        return key
    if not secret_key:
        msg = "o worker não tem ECLUME_ENCRYPTION_KEY nem ECLUME_SECRET_KEY"
        raise SecretError(msg)
    hkdf = HKDF(algorithm=hashes.SHA256(), length=_KEY_BYTES, salt=None, info=b"eclume-secrets-v1")
    return hkdf.derive(secret_key.encode())


def open_secret(token: str, *, encryption_key: str | None, secret_key: str | None) -> str:
    """Plaintext of the secret encrypted by the server."""
    if not token.startswith(_PREFIX):
        msg = "formato de segredo desconhecido"
        raise SecretError(msg)
    key = _key(encryption_key, secret_key)
    try:
        raw = base64.b64decode(token[len(_PREFIX) :], validate=True)
        return AESGCM(key).decrypt(raw[:_NONCE], raw[_NONCE:], None).decode()
    except (binascii.Error, InvalidTag, ValueError) as exc:
        msg = "o segredo não abre com a chave de cifra do worker"
        raise SecretError(msg) from exc
