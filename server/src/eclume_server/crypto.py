"""Cifra de segredos guardados no banco (chaves de API dos providers, segredos do admin).

AES-256-GCM com nonce aleatório; o texto cifrado é `v1:` + base64(nonce + cifra + tag). A chave
vem de `ECLUME_ENCRYPTION_KEY` (base64 de 32 bytes) ou, sem ela, é derivada de
`ECLUME_SECRET_KEY` por HKDF-SHA256. O valor em claro nunca volta pela API.
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
    """O texto cifrado não abre com a chave atual (chave trocada ou dado corrompido)."""


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
    """Cifra um segredo para guardar no banco."""
    nonce = os.urandom(_NONCE)
    sealed = AESGCM(_key(settings)).encrypt(nonce, plaintext.encode(), None)
    return _PREFIX + base64.b64encode(nonce + sealed).decode()


def decrypt(settings: Settings, token: str) -> str:
    """Abre um segredo guardado; chave errada ou dado corrompido → `SecretDecryptError`."""
    if not token.startswith(_PREFIX):
        msg = "formato de segredo desconhecido"
        raise SecretDecryptError(msg)
    try:
        raw = base64.b64decode(token[len(_PREFIX) :], validate=True)
        return AESGCM(_key(settings)).decrypt(raw[:_NONCE], raw[_NONCE:], None).decode()
    except (binascii.Error, InvalidTag, ValueError) as exc:
        msg = "o segredo não abre com a chave de cifra atual"
        raise SecretDecryptError(msg) from exc
