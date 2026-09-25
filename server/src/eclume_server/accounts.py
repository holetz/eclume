"""Criação de organizações e usuários (bootstrap pelo CLI e fábricas dos testes)."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, insert, select

from eclume_server.db import tables as t
from eclume_server.security import hash_password

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

MIN_PASSWORD = 12
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# Padrões da configuração em runtime (schema `AdminSettings`). A identificação por voz nasce
# desligada: é o opt-in da organização exigido pela LGPD.
DEFAULT_ORG_SETTINGS: dict[str, dict[str, Any]] = {
    "asr": {
        "engine": "whisperx-local",
        "model": "large-v3-turbo",
        "compute_type": "int8_float16",
        "batch_size": None,
        "default_language": "pt",
        "fallback_model": "medium",
        "endpoint_url": None,
    },
    "diarization": {
        "enabled": True,
        "model": "pyannote/speaker-diarization-community-1",
        "min_speakers": None,
        "max_speakers": None,
    },
    "summarization": {"default_provider_id": None, "auto_summarize": False, "default_template_id": None},
    "voice_identification": {"enabled": False, "suggestion_threshold": 0.75},
}


class AccountError(ValueError):
    """Dado de conta inválido ou já existente."""


async def create_org(conn: AsyncConnection, name: str) -> UUID:
    """Cria a organização com a configuração padrão."""
    if not name.strip():
        msg = "o nome da organização não pode ser vazio"
        raise AccountError(msg)
    org_id = (
        await conn.execute(insert(t.organizations).values(name=name.strip()).returning(t.organizations.c.id))
    ).scalar_one()
    await conn.execute(insert(t.org_settings).values(org_id=org_id, **DEFAULT_ORG_SETTINGS))
    return org_id


async def create_user(  # noqa: PLR0913 — campos da conta, todos nomeados
    conn: AsyncConnection, org_id: UUID, *, email: str, name: str, password: str, role: str = "member"
) -> UUID:
    """Cria um usuário ativo; e-mail é único na instância."""
    if not _EMAIL_RE.match(email):
        msg = f"e-mail inválido: {email}"
        raise AccountError(msg)
    if len(password) < MIN_PASSWORD:
        msg = f"a senha precisa de ao menos {MIN_PASSWORD} caracteres"
        raise AccountError(msg)
    if role not in {"admin", "member"}:
        msg = f"papel inválido: {role}"
        raise AccountError(msg)
    taken = await conn.execute(select(t.users.c.id).where(func.lower(t.users.c.email) == email.lower()))
    if taken.first() is not None:
        msg = f"e-mail já cadastrado: {email}"
        raise AccountError(msg)
    return (
        await conn.execute(
            insert(t.users)
            .values(org_id=org_id, email=email, name=name, password_hash=hash_password(password), role=role)
            .returning(t.users.c.id)
        )
    ).scalar_one()
