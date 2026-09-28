"""Credencial de dispositivo: o token `kind: device` que o desktop e o celular recebem ao entrar.

Padrão em docs/standards/code/server-mcp-e-dispositivos.md.
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

# Upload, marcadores e status das próprias gravações, e o resumo pronto para o aviso do app com
# "Copiar"; sem validade, revogável na web.
DEVICE_SCOPES = ("recordings:read", "recordings:write", "summaries:read")


async def issue_credential(
    conn: AsyncConnection, user_id: UUID, device_name: str, platform: str, server: dict[str, Any]
) -> dict[str, Any]:
    """Cria o token de dispositivo e devolve o schema `DeviceCredential` (o segredo só aqui)."""
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
    """Schema `PairingCode`, sem o código (que o banco não guarda)."""
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
    """Novo código do usuário (vence os anteriores ainda pendentes), com o link do QR."""
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
            # Colisão com um código ainda não usado (de qualquer conta): sorteia outro.
            continue
    query = {"codigo": code} | ({"ca": server["ca_sha256"]} if server["ca_sha256"] else {})
    return pairing_code_json(row, now) | {
        "code": code,
        "display": f"{code[:3]}-{code[3:]}",
        "pair_url": f"{server['url']}/parear?{urlencode(query)}",
    }


async def redeem_pairing_code(conn: AsyncConnection, raw: str, secret_key: str) -> Row | None:
    """Marca o código como usado, de forma atômica; `None` se inexistente, vencido, usado ou de conta inativa."""
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
    """Registra no código a credencial que ele emitiu."""
    await conn.execute(update(t.pairing_codes).where(t.pairing_codes.c.id == pairing_code_id).values(token_id=token_id))
