"""Credencial de dispositivo: o token `kind: device` que o desktop e o celular recebem ao entrar.

Padrão em docs/standards/code/server-mcp-e-dispositivos.md.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import insert

from eclume_server.db import tables as t
from eclume_server.routes.tokens import token_json
from eclume_server.security import new_pat, sha256_hex

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

# Upload, marcadores e status das próprias gravações; sem validade, revogável na web.
DEVICE_SCOPES = ("recordings:read", "recordings:write")


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
