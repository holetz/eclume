"""JSON shapes shared by the routes."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from sqlalchemy import func, select

from eclume_server.db import tables as t
from eclume_server.pagination import iso

Row = Mapping[str, Any]
"""Linha de consulta (`RowMapping` do SQLAlchemy) ou dict equivalente."""


def user_json(row: Row) -> dict[str, Any]:
    """Schema `User`."""
    return {
        "id": str(row["id"]),
        "email": row["email"],
        "name": row["name"],
        "active": row["active"],
        "created_at": iso(row["created_at"]),
        "last_login_at": iso(row["last_login_at"]),
        "notice_version": row["notice_version"],
        "notice_accepted_at": iso(row["notice_accepted_at"]),
    }


def requester_name() -> Any:  # noqa: ANN401 — SQLAlchemy ScalarSelect
    """The name of the transaction's user (`eclume_user()`), read once per query.

    Fills the obsolete `owner`/`created_by` fields of contract v1: under RLS, every returned record
    belongs to the user themselves, so no query joins `users` for this.
    """
    return select(t.users.c.name).where(t.users.c.id == func.eclume_user()).scalar_subquery()


def user_ref(user_id: Any, name: str) -> dict[str, str]:  # noqa: ANN401 — UUID or text
    """Schema `UserRef`."""
    return {"id": str(user_id), "name": name}
