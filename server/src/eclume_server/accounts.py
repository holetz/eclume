"""Contas: de usuário (cadastro e fábricas dos testes) e de admin (CLI)."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import delete, func, insert, select, text, update
from sqlalchemy.exc import IntegrityError

from eclume_server.db import tables as t
from eclume_server.security import hash_password

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

MIN_PASSWORD = 12
# Aviso que toda conta aceita (substitui o consentimento de voz por pessoa). Texto novo, versão nova:
# as contas que aceitaram a anterior voltam a ver `notice_required`.
NOTICE_VERSION = "1"
NOTICE_TEXT = "Sou responsável por pedir o consentimento das pessoas que gravo."
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class AccountError(ValueError):
    """Dado de conta inválido ou já existente."""


class EmailTakenError(AccountError):
    """Já existe conta de usuário com o e-mail."""


def notice() -> dict[str, str]:
    """Schema `Notice`: o aviso em vigor."""
    return {"version": NOTICE_VERSION, "text": NOTICE_TEXT}


def _check(email: str, password: str) -> None:
    if not _EMAIL_RE.match(email):
        msg = f"e-mail inválido: {email}"
        raise AccountError(msg)
    if len(password) < MIN_PASSWORD:
        msg = f"a senha precisa de ao menos {MIN_PASSWORD} caracteres"
        raise AccountError(msg)


async def email_taken(conn: AsyncConnection, email: str) -> bool:
    """Já há conta de usuário com o e-mail (sem distinção de caixa)."""
    query = select(t.users.c.id).where(func.lower(t.users.c.email) == email.lower())
    return (await conn.execute(query)).first() is not None


async def create_user(
    conn: AsyncConnection, *, email: str, name: str, password: str, notice_version: str | None = None
) -> UUID:
    """Cria uma conta de usuário ativa, com os tipos de agenda padrão; e-mail único na instância.

    Com `notice_version`, a conta nasce com o aceite do aviso (o cadastro). Roda com o papel de
    conexão: a conta ainda não existe para a RLS.
    """
    _check(email, password)
    msg = f"e-mail já cadastrado: {email}"
    if await email_taken(conn, email):
        raise EmailTakenError(msg)
    accepted = {"notice_version": notice_version, "notice_accepted_at": datetime.now(UTC)} if notice_version else {}
    try:
        async with conn.begin_nested():
            user_id = (
                await conn.execute(
                    insert(t.users)
                    .values(email=email, name=name, password_hash=hash_password(password), **accepted)
                    .returning(t.users.c.id)
                )
            ).scalar_one()
    except IntegrityError as exc:
        # Dois cadastros simultâneos com o mesmo e-mail: o índice único decide.
        raise EmailTakenError(msg) from exc
    # Os padrões vêm de `default_agenda_types` (migration 009), mantidos pelo admin.
    await conn.execute(text("SELECT eclume_seed_user_defaults(:user)"), {"user": user_id})
    return user_id


async def create_admin(conn: AsyncConnection, *, email: str, name: str, password: str) -> UUID:
    """Cria uma conta de admin; o mesmo e-mail pode ter conta de usuário, que é outra conta."""
    _check(email, password)
    taken = await conn.execute(select(t.admins.c.id).where(func.lower(t.admins.c.email) == email.lower()))
    if taken.first() is not None:
        msg = f"admin já cadastrado: {email}"
        raise AccountError(msg)
    return (
        await conn.execute(
            insert(t.admins)
            .values(email=email, name=name, password_hash=hash_password(password))
            .returning(t.admins.c.id)
        )
    ).scalar_one()


async def set_admin_password(conn: AsyncConnection, *, email: str, password: str) -> UUID:
    """Troca a senha do admin e encerra as sessões dele."""
    if len(password) < MIN_PASSWORD:
        msg = f"a senha precisa de ao menos {MIN_PASSWORD} caracteres"
        raise AccountError(msg)
    admin_id = (
        await conn.execute(
            update(t.admins)
            .where(func.lower(t.admins.c.email) == email.lower())
            .values(password_hash=hash_password(password))
            .returning(t.admins.c.id)
        )
    ).scalar()
    if admin_id is None:
        msg = f"admin inexistente: {email}"
        raise AccountError(msg)
    await conn.execute(delete(t.admin_sessions).where(t.admin_sessions.c.admin_id == admin_id))
    return admin_id
