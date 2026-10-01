"""Contas: de usuário (cadastro e fábricas dos testes) e de admin (CLI)."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import delete, func, insert, select, text, update
from sqlalchemy.exc import IntegrityError

from eclume_server.db import tables as t
from eclume_server.db.session import system_tx
from eclume_server.security import hash_password_async, needs_rehash, verify_password_async

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

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


class WrongPasswordError(AccountError):
    """A senha informada não é a da conta."""


def notice() -> dict[str, str]:
    """Schema `Notice`: o aviso em vigor."""
    return {"version": NOTICE_VERSION, "text": NOTICE_TEXT}


def _check_email(email: str) -> None:
    if not _EMAIL_RE.match(email):
        msg = f"e-mail inválido: {email}"
        raise AccountError(msg)


def _check_password(password: str) -> None:
    if len(password) < MIN_PASSWORD:
        msg = f"a senha precisa de ao menos {MIN_PASSWORD} caracteres"
        raise AccountError(msg)


async def new_password_hash(password: str) -> str:
    """Hash de uma senha nova, conferido o tamanho mínimo; calcule-o antes de abrir a transação."""
    _check_password(password)
    return await hash_password_async(password)


async def email_taken(conn: AsyncConnection, email: str) -> bool:
    """Já há conta de usuário com o e-mail (sem distinção de caixa)."""
    query = select(t.users.c.id).where(func.lower(t.users.c.email) == email.lower())
    return (await conn.execute(query)).first() is not None


async def create_user(
    conn: AsyncConnection, *, email: str, name: str, password_hash: str, notice_version: str | None = None
) -> UUID:
    """Cria uma conta de usuário ativa, com os tipos de agenda padrão; e-mail único na instância.

    `password_hash` vem de `new_password_hash`, calculado fora da transação. Com `notice_version`, a
    conta nasce com o aceite do aviso (o cadastro). Roda com o papel de conexão: a conta ainda não
    existe para a RLS.
    """
    _check_email(email)
    msg = f"e-mail já cadastrado: {email}"
    if await email_taken(conn, email):
        raise EmailTakenError(msg)
    accepted = {"notice_version": notice_version, "notice_accepted_at": datetime.now(UTC)} if notice_version else {}
    try:
        async with conn.begin_nested():
            user_id = (
                await conn.execute(
                    insert(t.users)
                    .values(email=email, name=name, password_hash=password_hash, **accepted)
                    .returning(t.users.c.id)
                )
            ).scalar_one()
    except IntegrityError as exc:
        # Dois cadastros simultâneos com o mesmo e-mail: o índice único decide.
        raise EmailTakenError(msg) from exc
    # Os padrões vêm de `default_agenda_types` (migration 009), mantidos pelo admin.
    await conn.execute(text("SELECT eclume_seed_user_defaults(:user)"), {"user": user_id})
    return user_id


async def password_login(engine: AsyncEngine, email: str, password: str) -> UUID | None:
    """Confere e-mail e senha de uma conta ativa e registra o login; `None` quando não confere.

    O argon2 roda fora do event loop e fora de transação. E-mail inexistente gasta o mesmo tempo de
    argon2 que uma senha errada.
    """
    async with system_tx(engine) as conn:
        query = select(t.users).where(func.lower(t.users.c.email) == email.lower())
        user = (await conn.execute(query)).mappings().first()
    if not await verify_password_async(user["password_hash"] if user else None, password) or not user:
        return None
    if not user["active"]:
        return None
    values: dict[str, Any] = {"last_login_at": datetime.now(UTC)}
    if needs_rehash(user["password_hash"]):
        values["password_hash"] = await hash_password_async(password)
    async with system_tx(engine) as conn:
        await conn.execute(update(t.users).where(t.users.c.id == user["id"]).values(**values))
    return user["id"]


async def confirm_password(engine: AsyncEngine, user_id: UUID, password: str, message: str = "senha incorreta") -> None:
    """Confere a senha da conta fora de transação; errada é `WrongPasswordError(message)`."""
    async with system_tx(engine) as conn:
        stored = (await conn.execute(select(t.users.c.password_hash).where(t.users.c.id == user_id))).scalar()
    if not await verify_password_async(stored, password):
        raise WrongPasswordError(message)


async def change_password(
    engine: AsyncEngine,
    user_id: UUID,
    new: str,
    *,
    keep_session: UUID | None,
    revoke_tokens: bool = False,
) -> None:
    """Troca a senha da conta e encerra as outras sessões dela; confira antes a atual com `confirm_password`.

    Com `revoke_tokens`, revoga também os tokens da conta (credenciais de aparelho e PATs): quem troca
    a senha por suspeita de vazamento encerra todo acesso.
    """
    password_hash = await new_password_hash(new)
    async with system_tx(engine) as conn:
        await conn.execute(update(t.users).where(t.users.c.id == user_id).values(password_hash=password_hash))
        others = delete(t.sessions).where(t.sessions.c.user_id == user_id)
        if keep_session is not None:
            others = others.where(t.sessions.c.id != keep_session)
        await conn.execute(others)
        if revoke_tokens:
            await conn.execute(
                update(t.api_tokens)
                .where(t.api_tokens.c.user_id == user_id, t.api_tokens.c.revoked_at.is_(None))
                .values(revoked_at=datetime.now(UTC))
            )


async def purge_user(conn: AsyncConnection, user_id: UUID) -> bool:
    """Apaga a conta e tudo o que é dela (as FKs levam em cascata); diz se a conta existia.

    Na exclusão pela própria pessoa, confira antes a senha com `confirm_password`; o admin exclui
    sem ela. Os gatilhos das gravações e dos uploads em andamento põem os objetos na fila de
    exclusão do bucket na mesma transação.
    """
    return (await conn.execute(delete(t.users).where(t.users.c.id == user_id))).rowcount > 0


async def create_admin(conn: AsyncConnection, *, email: str, name: str, password: str) -> UUID:
    """Cria uma conta de admin; o mesmo e-mail pode ter conta de usuário, que é outra conta."""
    _check_email(email)
    password_hash = await new_password_hash(password)
    taken = await conn.execute(select(t.admins.c.id).where(func.lower(t.admins.c.email) == email.lower()))
    if taken.first() is not None:
        msg = f"admin já cadastrado: {email}"
        raise AccountError(msg)
    return (
        await conn.execute(
            insert(t.admins).values(email=email, name=name, password_hash=password_hash).returning(t.admins.c.id)
        )
    ).scalar_one()


async def set_admin_password(conn: AsyncConnection, *, email: str, password: str) -> UUID:
    """Troca a senha do admin e encerra as sessões dele."""
    password_hash = await new_password_hash(password)
    admin_id = (
        await conn.execute(
            update(t.admins)
            .where(func.lower(t.admins.c.email) == email.lower())
            .values(password_hash=password_hash)
            .returning(t.admins.c.id)
        )
    ).scalar()
    if admin_id is None:
        msg = f"admin inexistente: {email}"
        raise AccountError(msg)
    await conn.execute(delete(t.admin_sessions).where(t.admin_sessions.c.admin_id == admin_id))
    return admin_id
