"""Formas JSON compartilhadas pelas rotas."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

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


def user_ref(user_id: Any, name: str) -> dict[str, str]:  # noqa: ANN401 — UUID ou texto
    """Schema `UserRef`."""
    return {"id": str(user_id), "name": name}
