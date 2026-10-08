"""Paginação por cursor opaco (`?cursor=&limit=`, resposta `{items, next_cursor}`)."""

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


def __getattr__(name: str) -> Any:  # noqa: ANN401 — PEP 562: `Limit` e `Cursor` só existem com FastAPI
    """Os parâmetros de rota `Limit` e `Cursor` carregam o FastAPI na primeira importação; o worker não os usa."""
    if name not in {"Limit", "Cursor"}:
        raise AttributeError(name)
    from fastapi import Query  # noqa: PLC0415

    globals()["Limit"] = Annotated[int, Query(ge=1, le=200, description="Itens por página.")]
    globals()["Cursor"] = Annotated[str | None, Query(description="Cursor opaco devolvido em `next_cursor`.")]
    return globals()[name]


def iso(value: datetime | None) -> str | None:
    """RFC 3339 em UTC com `Z`."""
    if value is None:
        return None
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def encode_cursor(sort_value: datetime, row_id: UUID) -> str:
    """Cursor opaco da posição `(ordenação, id)`."""
    return _encode([sort_value.isoformat(), str(row_id)])


def _encode(values: list[str]) -> str:
    """Base64url do JSON em UTF-8 direto: um emoji custa 4 bytes, e não os 12 do escape duplo."""
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
    """O JSON dentro de um cursor base64url; grande demais, base64, UTF-8, formato, JSON inválidos ou aninhados viram 422 no campo `cursor`."""
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
    """Posição de um cursor; inválido vira 422 no campo `cursor`."""
    sort_value, row_id = decode_position(cursor, 2)
    try:
        return datetime.fromisoformat(sort_value), UUID(row_id)
    except ValueError as exc:
        raise invalid_field("cursor", "cursor inválido") from exc


def encode_position(*values: object) -> str:
    """Cursor opaco de uma posição qualquer (texto, número, id), para ordenações sem data."""
    return _encode([str(value) for value in values])


def decode_position(cursor: str, size: int) -> list[str]:
    """Os `size` valores de um cursor de `encode_position`; inválido vira 422 no campo `cursor`."""
    values = _decode_json(cursor)
    if not isinstance(values, list) or len(values) != size or not all(isinstance(v, str) for v in values):
        raise invalid_field("cursor", "cursor inválido")
    return values


def decode_ordered_position(cursor: str) -> tuple[int, UUID]:
    """Posição `(position, id)` das listas na ordem escolhida pelo usuário."""
    position, row_id = decode_position(cursor, 2)
    try:
        return int(position), UUID(row_id)
    except ValueError as exc:
        raise invalid_field("cursor", "cursor inválido") from exc


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
