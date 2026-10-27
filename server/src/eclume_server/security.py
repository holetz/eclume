"""Security primitives: passwords (argon2id), secrets and the signing of part URLs."""

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
# Hash of an arbitrary password: a login for a nonexistent e-mail spends the same time as an existing one.
_DUMMY_HASH = _hasher.hash("eclume-dummy-password")


def hash_password(password: str) -> str:
    """argon2id hash of the password."""
    return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    """Check the password; `None` spends the same time and fails."""
    try:
        return _hasher.verify(password_hash or _DUMMY_HASH, password) and password_hash is not None
    except (VerificationError, InvalidHashError):
        return False


# Each argon2 hash uses 64 MiB: the default pool of 40 threads would make room for 2.5 GiB per burst.
PASSWORD_THREADS = 4
_limiters: WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = WeakKeyDictionary()


def _password_limiter() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    if loop not in _limiters:
        _limiters[loop] = asyncio.Semaphore(PASSWORD_THREADS)
    return _limiters[loop]


async def hash_password_async(password: str) -> str:
    """`hash_password` in a thread, up to `PASSWORD_THREADS` at a time: the event loop stays free."""
    async with _password_limiter():
        return await asyncio.to_thread(hash_password, password)


async def verify_password_async(password_hash: str | None, password: str) -> bool:
    """`verify_password` in a thread, up to `PASSWORD_THREADS` at a time."""
    async with _password_limiter():
        return await asyncio.to_thread(verify_password, password_hash, password)


def needs_rehash(password_hash: str) -> bool:
    """The argon2 parameters changed since the hash."""
    return _hasher.check_needs_rehash(password_hash)


def sha256_hex(value: str) -> str:
    """SHA-256 in hex: stores high-entropy secrets (session, PAT) without a slow hash."""
    return hashlib.sha256(value.encode()).hexdigest()


def new_pat() -> tuple[str, str]:
    """New PAT: (secret `eclp_...`, visible prefix)."""
    secret = PAT_PREFIX + "".join(secrets.choice(_ALPHABET) for _ in range(_PAT_BODY_LENGTH))
    return secret, secret[:_PAT_VISIBLE]


def new_pairing_code() -> str:
    """Pairing code: 6 characters without the ambiguous ones (0/1/I/L/O/U), 30^6 combinations."""
    return "".join(secrets.choice(PAIRING_ALPHABET) for _ in range(PAIRING_LENGTH))


def normalize_pairing_code(raw: str) -> str:
    """The code as the app typed it: uppercase, without hyphen or space."""
    return "".join(raw.split()).replace("-", "").upper()


def new_session_token() -> str:
    """Opaque session or CSRF token."""
    return secrets.token_urlsafe(32)


def sign(key: str, *parts: object) -> str:
    """HMAC-SHA256 in hex of parts joined by `:`."""
    message = ":".join(str(part) for part in parts).encode()
    return hmac.new(key.encode(), message, hashlib.sha256).hexdigest()


def signature_matches(key: str, signature: str, *parts: object) -> bool:
    """Compare the received signature with the expected one in constant time."""
    return hmac.compare_digest(sign(key, *parts), signature)
