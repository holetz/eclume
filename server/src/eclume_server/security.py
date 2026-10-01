"""Primitivas de segurança: senhas (argon2id), segredos e assinatura das URLs de parte."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import secrets
import string
from weakref import WeakKeyDictionary

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

PAT_PREFIX = "eclp_"
_PAT_BODY_LENGTH = 40
_PAT_VISIBLE = len(PAT_PREFIX) + 4
_ALPHABET = string.ascii_letters + string.digits
PAIRING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
PAIRING_LENGTH = 6
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


# Cada hash argon2 usa 64 MiB: o pool padrão de 40 threads abriria espaço para 2,5 GiB por rajada.
PASSWORD_THREADS = 4
_limiters: WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = WeakKeyDictionary()


def _password_limiter() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    if loop not in _limiters:
        _limiters[loop] = asyncio.Semaphore(PASSWORD_THREADS)
    return _limiters[loop]


async def hash_password_async(password: str) -> str:
    """`hash_password` numa thread, até `PASSWORD_THREADS` ao mesmo tempo: o event loop segue livre."""
    async with _password_limiter():
        return await asyncio.to_thread(hash_password, password)


async def verify_password_async(password_hash: str | None, password: str) -> bool:
    """`verify_password` numa thread, até `PASSWORD_THREADS` ao mesmo tempo."""
    async with _password_limiter():
        return await asyncio.to_thread(verify_password, password_hash, password)


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


def new_pairing_code() -> str:
    """Código de pareamento: 6 caracteres sem os ambíguos (0/1/I/L/O/U), 30^6 combinações."""
    return "".join(secrets.choice(PAIRING_ALPHABET) for _ in range(PAIRING_LENGTH))


def normalize_pairing_code(raw: str) -> str:
    """O código como o app o digitou: maiúsculas, sem hífen nem espaço."""
    return "".join(raw.split()).replace("-", "").upper()


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
