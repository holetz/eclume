"""Device credential: the `kind: device` token the desktop and the phone receive on sign-in.

Pattern in docs/standards/code/server-mcp-e-dispositivos.md.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any
from urllib.parse import urlencode

from sqlalchemy import insert, select, update
from sqlalchemy.exc import IntegrityError

from eclume_server.db import tables as t
from eclume_server.pagination import iso
from eclume_server.routes.tokens import token_json
from eclume_server.security import new_pairing_code, new_pat, normalize_pairing_code, sha256_hex, sign

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row

PAIRING_TTL = timedelta(minutes=10)

# Upload, markers and status of the account's own recordings, the ready summary for the app's
# notification with "Copiar", and reading summaries and transcripts for the desktop's synced folder;
# no expiry, revocable on the web.
DEVICE_SCOPES = ("recordings:read", "recordings:write", "transcripts:read", "summaries:read")


async def issue_credential(
    conn: AsyncConnection, user_id: UUID, device_name: str, platform: str, server: dict[str, Any]
) -> dict[str, Any]:
    """Create the device token and return the `DeviceCredential` schema (the secret only here)."""
    secret, prefix = new_pat()
    row = (
        (
            await conn.execute(
                insert(t.api_tokens)
                .values(
                    user_id=user_id,
                    name=device_name,
                    token_hash=sha256_hex(secret),
                    prefix=prefix,
                    scopes=list(DEVICE_SCOPES),
                    kind="device",
                    platform=platform,
                )
                .returning(t.api_tokens)
            )
        )
        .mappings()
        .one()
    )
    return {"token": token_json(row), "secret": secret, "server": server}


def _code_hmac(secret_key: str, code: str) -> str:
    return sign(secret_key, "pairing", code)


def pairing_code_json(row: Row, now: datetime | None = None) -> dict[str, Any]:
    """Schema `PairingCode`, without the code (which the database does not store)."""
    now = now or datetime.now(UTC)
    status = "used" if row["used_at"] else ("pending" if row["expires_at"] > now else "expired")
    return {
        "id": str(row["id"]),
        "status": status,
        "expires_at": iso(row["expires_at"]),
        "token_id": str(row["token_id"]) if row["token_id"] else None,
    }


async def create_pairing_code(
    conn: AsyncConnection, user_id: UUID, secret_key: str, server: dict[str, Any]
) -> dict[str, Any]:
    """New code for the user (expires the previous still pending ones), with the QR link."""
    now = datetime.now(UTC)
    codes = t.pairing_codes
    await conn.execute(
        update(codes)
        .where(codes.c.user_id == user_id, codes.c.used_at.is_(None), codes.c.expires_at > now)
        .values(expires_at=now)
    )
    while True:
        code = new_pairing_code()
        try:
            async with conn.begin_nested():
                row = (
                    (
                        await conn.execute(
                            insert(codes)
                            .values(
                                user_id=user_id, code_hmac=_code_hmac(secret_key, code), expires_at=now + PAIRING_TTL
                            )
                            .returning(codes)
                        )
                    )
                    .mappings()
                    .one()
                )
            break
        except IntegrityError:
            # Collision with a code not used yet (of any account): draw another.
            continue
    query = {"codigo": code} | ({"ca": server["ca_sha256"]} if server["ca_sha256"] else {})
    return pairing_code_json(row, now) | {
        "code": code,
        "display": f"{code[:3]}-{code[3:]}",
        "pair_url": f"{server['url']}/parear?{urlencode(query)}",
    }


async def redeem_pairing_code(conn: AsyncConnection, raw: str, secret_key: str) -> Row | None:
    """Mark the code as used, atomically; `None` if nonexistent, expired, used or of an inactive account."""
    codes = t.pairing_codes
    return (
        (
            await conn.execute(
                update(codes)
                .where(
                    codes.c.code_hmac == _code_hmac(secret_key, normalize_pairing_code(raw)),
                    codes.c.used_at.is_(None),
                    codes.c.expires_at > datetime.now(UTC),
                    codes.c.user_id.in_(select(t.users.c.id).where(t.users.c.active)),
                )
                .values(used_at=datetime.now(UTC))
                .returning(codes)
            )
        )
        .mappings()
        .first()
    )


async def link_token(conn: AsyncConnection, pairing_code_id: UUID, token_id: str) -> None:
    """Record on the code the credential it issued."""
    await conn.execute(update(t.pairing_codes).where(t.pairing_codes.c.id == pairing_code_id).values(token_id=token_id))
