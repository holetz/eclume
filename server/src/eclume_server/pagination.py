"""Paginação por cursor opaco (`?cursor=&limit=`, resposta `{items, next_cursor}`)."""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import UUID

from fastapi import Query

from eclume_server.problems import invalid_field

Limit = Annotated[int, Query(ge=1, le=200, description="Itens por página.")]
Cursor = Annotated[str | None, Query(description="Cursor opaco devolvido em `next_cursor`.")]


def iso(value: datetime | None) -> str | None:
    """RFC 3339 em UTC com `Z`."""
    if value is None:
        return None
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def encode_cursor(sort_value: datetime, row_id: UUID) -> str:
    """Cursor opaco da posição `(ordenação, id)`."""
    raw = json.dumps([sort_value.isoformat(), str(row_id)]).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, UUID]:
    """Posição de um cursor; inválido vira 422 no campo `cursor`."""
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        sort_value, row_id = json.loads(base64.urlsafe_b64decode(padded))
        return datetime.fromisoformat(sort_value), UUID(row_id)
    except (ValueError, TypeError) as exc:
        raise invalid_field("cursor", "cursor inválido") from exc


def encode_position(*values: object) -> str:
    """Cursor opaco de uma posição qualquer (texto, número, id), para ordenações sem data."""
    raw = json.dumps([str(value) for value in values]).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_position(cursor: str, size: int) -> list[str]:
    """Os `size` valores de um cursor de `encode_position`; inválido vira 422 no campo `cursor`."""
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        values = json.loads(base64.urlsafe_b64decode(padded))
    except (ValueError, TypeError) as exc:
        raise invalid_field("cursor", "cursor inválido") from exc
    if not isinstance(values, list) or len(values) != size or not all(isinstance(v, str) for v in values):
        raise invalid_field("cursor", "cursor inválido")
    return values


def decode_named_position(cursor: str) -> tuple[str, UUID]:
    """Posição `(nome ordenável, id)` das listas em ordem alfabética."""
    name, row_id = decode_position(cursor, 2)
    try:
        return name, UUID(row_id)
    except ValueError as exc:
        raise invalid_field("cursor", "cursor inválido") from exc


def page(items: list[dict[str, Any]], rows: list[Any], limit: int, sort_key: str) -> dict[str, Any]:
    """Monta a página a partir de `limit + 1` linhas lidas: a sobra só diz que há próxima."""
    next_cursor = None
    if len(rows) > limit:
        last = rows[limit - 1]
        next_cursor = encode_cursor(last[sort_key], last["id"])
    return {"items": items[:limit], "next_cursor": next_cursor}
