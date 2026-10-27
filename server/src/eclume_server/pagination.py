"""Opaque-cursor pagination (`?cursor=&limit=`, response `{items, next_cursor}`)."""

from __future__ import annotations

import base64
import json
import re
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Annotated, Any
from uuid import UUID

from eclume_server.limits import DEFAULT_LIMIT
from eclume_server.problems import invalid_field

if TYPE_CHECKING:
    from fastapi import Query

    Limit = Annotated[int, Query(ge=1, le=200, description="Itens por página.")]
    Cursor = Annotated[str | None, Query(description="Cursor opaco devolvido em `next_cursor`.")]


def __getattr__(name: str) -> Any:  # noqa: ANN401 — PEP 562: `Limit` and `Cursor` exist only with FastAPI
    """The route parameters `Limit` and `Cursor` load FastAPI on first import; the worker does not use them."""
    if name not in {"Limit", "Cursor"}:
        raise AttributeError(name)
    from fastapi import Query  # noqa: PLC0415

    globals()["Limit"] = Annotated[int, Query(ge=1, le=200, description="Itens por página.")]
    globals()["Cursor"] = Annotated[str | None, Query(description="Cursor opaco devolvido em `next_cursor`.")]
    return globals()[name]


def iso(value: datetime | None) -> str | None:
    """RFC 3339 in UTC with `Z`."""
    if value is None:
        return None
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def encode_cursor(sort_value: datetime, row_id: UUID) -> str:
    """Opaque cursor of the `(sort key, id)` position."""
    return _encode([sort_value.isoformat(), str(row_id)])


def _encode(values: list[str]) -> str:
    """Base64url of the JSON in plain UTF-8: an emoji costs 4 bytes, not the 12 of the double escape."""
    raw = json.dumps(values, ensure_ascii=False).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


_MAX_JSON_BYTES = 2 * DEFAULT_LIMIT + 512
MAX_CURSOR_LENGTH = -(-_MAX_JSON_BYTES // 3) * 4
"""Teto do cursor, derivado do maior valor que o servidor emite e não medido sobre exemplos.

O maior nome é o corpo máximo da API (`DEFAULT_LIMIT`, 1 MiB); o JSON do cursor o carrega em UTF-8 direto,
no máximo um byte por byte do corpo, e o dobro absorve o que `unaccent` expande no `sort_name`. O teto é
o comprimento base64 desse JSON mais uma folga para colchetes, aspas e o id.
"""

_JSON_STRING = r'"[^"\\]*(?:\\.[^"\\]*)*"'
_FLAT_LIST = re.compile(rf"\[\s*{_JSON_STRING}(?:\s*,\s*{_JSON_STRING})*\s*\]", re.DOTALL)
"""Uma lista plana de strings JSON, em tempo linear: qualquer `[` ou `{` fora de string reprova."""


def _decode_json(cursor: str) -> object:
    """The JSON inside a base64url cursor; too large, or invalid or nested base64, UTF-8, format or JSON, becomes 422 on the `cursor` field."""
    if len(cursor) > MAX_CURSOR_LENGTH:
        raise invalid_field("cursor", "cursor inválido")
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        text = base64.urlsafe_b64decode(padded).decode()
        if not _FLAT_LIST.fullmatch(text):
            raise invalid_field("cursor", "cursor inválido")
        return json.loads(text)
    except ValueError as exc:
        raise invalid_field("cursor", "cursor inválido") from exc


def decode_cursor(cursor: str) -> tuple[datetime, UUID]:
    """Position of a cursor; an invalid one becomes 422 on the `cursor` field."""
    sort_value, row_id = decode_position(cursor, 2)
    try:
        return datetime.fromisoformat(sort_value), UUID(row_id)
    except ValueError as exc:
        raise invalid_field("cursor", "cursor inválido") from exc


def encode_position(*values: object) -> str:
    """Opaque cursor of an arbitrary position (text, number, id), for orderings without a date."""
    return _encode([str(value) for value in values])


def decode_position(cursor: str, size: int) -> list[str]:
    """The `size` values of an `encode_position` cursor; an invalid one becomes 422 on the `cursor` field."""
    values = _decode_json(cursor)
    if not isinstance(values, list) or len(values) != size or not all(isinstance(v, str) for v in values):
        raise invalid_field("cursor", "cursor inválido")
    return values


def decode_ordered_position(cursor: str) -> tuple[int, UUID]:
    """`(position, id)` position of the lists in the order the user chose."""
    position, row_id = decode_position(cursor, 2)
    try:
        return int(position), UUID(row_id)
    except ValueError as exc:
        raise invalid_field("cursor", "cursor inválido") from exc


def decode_named_position(cursor: str) -> tuple[str, UUID]:
    """`(sortable name, id)` position of the lists in alphabetical order."""
    name, row_id = decode_position(cursor, 2)
    try:
        return name, UUID(row_id)
    except ValueError as exc:
        raise invalid_field("cursor", "cursor inválido") from exc


def page(items: list[dict[str, Any]], rows: list[Any], limit: int, sort_key: str) -> dict[str, Any]:
    """Build the page from `limit + 1` rows read: the extra one only says there is a next page."""
    next_cursor = None
    if len(rows) > limit:
        last = rows[limit - 1]
        next_cursor = encode_cursor(last[sort_key], last["id"])
    return {"items": items[:limit], "next_cursor": next_cursor}
