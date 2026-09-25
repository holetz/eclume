"""Primitivas de segurança: senhas (argon2id), segredos e assinatura das URLs de parte."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import string

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

PAT_PREFIX = "eclp_"
INVITATION_PREFIX = "ecli_"
_PAT_BODY_LENGTH = 40
_INVITATION_BODY_LENGTH = 32
_PAT_VISIBLE = len(PAT_PREFIX) + 4
_ALPHABET = string.ascii_letters + string.digits
_hasher = PasswordHasher()
# Hash de uma senha qualquer: o login de e-mail inexistente gasta o mesmo tempo que o de um existente.
_DUMMY_HASH = _hasher.hash("eclume-dummy-password")


def hash_password(password: str) -> str:
    """Hash argon2id da senha."""
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    """Confere a senha; `None` gasta o mesmo tempo e falha."""
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerificationError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    """Os parâmetros do argon2 mudaram desde o hash."""
    return _hasher.check_needs_rehash(password_hash)


def sha256_hex(value: str) -> str:
    """SHA-256 em hex: guarda segredos de alta entropia (sessão, PAT) sem hash lento."""
    return hashlib.sha256(value.encode()).hexdigest()


def new_pat() -> tuple[str, str]:
    """Novo PAT: (segredo `eclp_...`, prefixo visível)."""
    secret = PAT_PREFIX + "".join(secrets.choice(_ALPHABET) for _ in range(_PAT_BODY_LENGTH))
    return secret, secret[:_PAT_VISIBLE]


def new_invitation_token() -> str:
    """Token do link de convite (`ecli_` + 32 base62, ~190 bits); o banco guarda o SHA-256."""
    return INVITATION_PREFIX + "".join(secrets.choice(_ALPHABET) for _ in range(_INVITATION_BODY_LENGTH))


def new_session_token() -> str:
    """Token opaco de sessão ou de CSRF."""
    return secrets.token_urlsafe(32)


def sign(key: str, *parts: object) -> str:
    """HMAC-SHA256 em hex de partes separadas por `:`."""
    message = ":".join(str(part) for part in parts).encode()
    return hmac.new(key.encode(), message, hashlib.sha256).hexdigest()


def signature_matches(key: str, signature: str, *parts: object) -> bool:
    """Compara em tempo constante a assinatura recebida com a esperada."""
    return hmac.compare_digest(sign(key, *parts), signature)
