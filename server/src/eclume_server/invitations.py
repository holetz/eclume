"""Convites por link: forma JSON, estado calculado e o aceite que cria a conta.

Regras em docs/standards/code/server-admin.md. O token só existe na resposta da criação (dentro de
`accept_url`); o banco guarda o SHA-256, como nos PATs.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import insert, select, update

from eclume_server.accounts import AccountError, create_user
from eclume_server.db import tables as t
from eclume_server.pagination import iso
from eclume_server.problems import invalid_field, not_found
from eclume_server.security import sha256_hex
from eclume_server.serialize import user_ref

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row

DEFAULT_TTL_DAYS = 7
# Caminho da página de aceite no app web (`/convite/:token`).
ACCEPT_PATH = "/convite/"
_REMOVED = "00000000-0000-0000-0000-000000000000"


def invitation_status(row: Row, now: datetime) -> str:
    """`accepted`, `expired` ou `pending`."""
    if row["accepted_at"] is not None:
        return "accepted"
    return "expired" if row["expires_at"] <= now else "pending"


def invitation_json(row: Row, now: datetime, accept_url: str | None = None) -> dict[str, Any]:
    """Schema `Invitation`; `accept_url` só na resposta da criação."""
    creator = row["created_by"]
    body: dict[str, Any] = {
        "id": str(row["id"]),
        "email": row["email"],
        "role": row["role"],
        "group_ids": [str(g) for g in row["group_ids"]],
        "expires_at": iso(row["expires_at"]),
        "accepted_at": iso(row["accepted_at"]),
        "created_by": user_ref(creator, row["created_by_name"]) if creator else user_ref(_REMOVED, "Usuário removido"),
        "status": invitation_status(row, now),
        "created_at": iso(row["created_at"]),
    }
    if accept_url is not None:
        body["accept_url"] = accept_url
    return body


def invitation_select() -> Any:  # noqa: ANN401 — `Select` do SQLAlchemy
    """Convites com o nome de quem convidou."""
    return select(t.invitations, t.users.c.name.label("created_by_name")).outerjoin(
        t.users, t.users.c.id == t.invitations.c.created_by
    )


async def accept(conn: AsyncConnection, token: str, *, name: str, password: str) -> UUID:
    """Cria a conta do convite válido e devolve o id do usuário; roda com o papel de sistema.

    Token inexistente, expirado ou já usado → 404, sem distinguir. E-mail tomado → 422.
    """
    invitation = (
        (
            await conn.execute(
                select(t.invitations).where(t.invitations.c.token_hash == sha256_hex(token)).with_for_update()
            )
        )
        .mappings()
        .first()
    )
    if invitation is None or invitation_status(invitation, datetime.now(UTC)) != "pending":
        raise not_found("Convite inválido, expirado ou já usado.")
    try:
        user_id = await create_user(
            conn,
            invitation["org_id"],
            email=invitation["email"],
            name=name.strip(),
            password=password,
            role=invitation["role"],
        )
    except AccountError as exc:
        raise invalid_field("email", str(exc)) from exc
    # Grupos apagados depois do convite ficam de fora.
    groups = (
        await conn.execute(
            select(t.groups.c.id).where(
                t.groups.c.org_id == invitation["org_id"], t.groups.c.id.in_(invitation["group_ids"])
            )
        )
    ).scalars()
    for group_id in groups:
        await conn.execute(
            insert(t.group_members).values(group_id=group_id, user_id=user_id, org_id=invitation["org_id"])
        )
    await conn.execute(
        update(t.invitations)
        .where(t.invitations.c.id == invitation["id"])
        .values(accepted_at=datetime.now(UTC), accepted_user_id=user_id)
    )
    return user_id
