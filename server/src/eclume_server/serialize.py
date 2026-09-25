"""Formas JSON compartilhadas pelas rotas."""

from __future__ import annotations

from typing import Any

from eclume_server.pagination import iso


def user_json(row: Any) -> dict[str, Any]:  # noqa: ANN401 — linha do SQLAlchemy
    """Schema `User`."""
    return {
        "id": str(row["id"]),
        "email": row["email"],
        "name": row["name"],
        "role": row["role"],
        "active": row["active"],
        "created_at": iso(row["created_at"]),
        "last_login_at": iso(row["last_login_at"]),
    }


def user_ref(user_id: Any, name: str) -> dict[str, str]:  # noqa: ANN401 — UUID ou texto
    """Schema `UserRef`."""
    return {"id": str(user_id), "name": name}
