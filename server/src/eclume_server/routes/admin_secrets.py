"""Segredos da plataforma (`/admin/secrets`). Só a sessão de admin.

O valor entra cifrado (`crypto.encrypt`) e nunca volta: a listagem diz só `is_set` e `updated_at`.
Os nomes são fixos (`settings_admin.KNOWN_SECRETS`), porque cada um tem um leitor definido.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert

from eclume_server.auth import Admin, require_admin
from eclume_server.context import AppContext, get_ctx
from eclume_server.crypto import encrypt
from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.pagination import iso
from eclume_server.problems import invalid_field, not_found
from eclume_server.settings_admin import KNOWN_SECRETS

router = APIRouter(prefix="/admin", dependencies=[Depends(require_admin)])
Ctx = Annotated[AppContext, Depends(get_ctx)]


class SecretPut(BaseModel):
    """Schema `SecretPut`."""

    value: str = Field(min_length=1)


@router.get("/secrets")
async def list_secrets(ctx: Ctx) -> dict[str, Any]:
    """Cada segredo conhecido, definido ou não; nunca o valor."""
    async with system_tx(ctx.engine) as conn:
        rows = (await conn.execute(select(t.platform_secrets.c.name, t.platform_secrets.c.updated_at))).all()
    stored = dict(rows)
    return {
        "items": [
            {"name": name, "is_set": name in stored, "updated_at": iso(stored.get(name))} for name in KNOWN_SECRETS
        ]
    }


@router.put("/secrets/{secret_name}", status_code=204)
async def put_secret(secret_name: str, body: SecretPut, admin: Admin, ctx: Ctx) -> Response:
    """Grava (ou troca) o segredo, cifrado."""
    if secret_name not in KNOWN_SECRETS:
        raise invalid_field("secret_name", f"segredo desconhecido; use {', '.join(KNOWN_SECRETS)}")
    value = body.value.strip()
    if not value:
        raise invalid_field("value", "não pode ser vazio")
    values = {
        "value_encrypted": encrypt(ctx.settings, value),
        "updated_at": func.now(),
        "updated_by": admin.admin_id,
    }
    async with system_tx(ctx.engine) as conn:
        await conn.execute(
            insert(t.platform_secrets)
            .values(name=secret_name, **values)
            .on_conflict_do_update(index_elements=["name"], set_=values)
        )
    return Response(status_code=204)


@router.delete("/secrets/{secret_name}", status_code=204)
async def delete_secret(secret_name: str, ctx: Ctx) -> Response:
    """Apaga o segredo; 404 se não estava definido."""
    async with system_tx(ctx.engine) as conn:
        result = await conn.execute(delete(t.platform_secrets).where(t.platform_secrets.c.name == secret_name))
    if result.rowcount == 0:
        raise not_found("Segredo não definido.")
    return Response(status_code=204)
