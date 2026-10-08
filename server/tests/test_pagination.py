"""Cursores de paginação: o que é malformado vira 422 `cursor inválido`, nunca 500."""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime
from typing import TYPE_CHECKING
from uuid import uuid4

import pytest

from eclume_server.pagination import MAX_CURSOR_LENGTH, decode_cursor, decode_position, encode_cursor, encode_position
from eclume_server.problems import ApiProblemError

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api


def _raw(value: object) -> str:
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")


def test_cursor_valido_faz_ida_e_volta():
    moment, row_id = datetime(2026, 1, 1, tzinfo=UTC), uuid4()
    assert decode_cursor(encode_cursor(moment, row_id)) == (moment, row_id)


@pytest.mark.parametrize(
    "cursor",
    [
        _raw(["2026-01-01T00:00:00", 5]),
        _raw(["2026-01-01T00:00:00", []]),
        _raw([5, str(uuid4())]),
        _raw(["2026-01-01T00:00:00"]),
        _raw(["2026-01-01T00:00:00", str(uuid4()), "x"]),
        _raw({"a": 1}),
        _raw("texto"),
        _raw(None),
        _raw(["nao-e-data", str(uuid4())]),
        _raw(["2026-01-01T00:00:00", "nao-e-uuid"]),
        "WyIyMDI2LTAxLTAxVDAwOjAwOjAwIiwgNV0",
        "lixo",
        "!!!",
        "/w",
        base64.urlsafe_b64encode(b"nao json").decode(),
    ],
)
def test_decode_cursor_malformado_vira_422(cursor: str):
    with pytest.raises(ApiProblemError) as caught:
        decode_cursor(cursor)
    assert caught.value.status_code == 422


@pytest.mark.parametrize("cursor", [_raw(["a", 1]), _raw(["a"]), _raw("a"), _raw({}), "lixo", "/w"])
def test_decode_position_malformado_vira_422(cursor: str):
    with pytest.raises(ApiProblemError) as caught:
        decode_position(cursor, 2)
    assert caught.value.status_code == 422


def test_position_valida_faz_ida_e_volta():
    assert decode_position(encode_position("a", 2), 2) == ["a", "2"]


ANINHADO = _raw("[" * 20000)


@pytest.mark.parametrize("cursor", [ANINHADO, "A" * 100_000, "A" * (MAX_CURSOR_LENGTH + 1)])
def test_cursor_aninhado_ou_grande_demais_vira_422(cursor: str):
    for decode in (decode_cursor, lambda c: decode_position(c, 2)):
        with pytest.raises(ApiProblemError) as caught:
            decode(cursor)
        assert caught.value.status_code == 422


def test_teto_tem_folga_para_os_cursores_reais():
    nome = "\U0001f600" * 400
    cursor = encode_position(nome, uuid4())
    assert len(cursor) < MAX_CURSOR_LENGTH
    assert decode_position(cursor, 2)[0] == nome
    assert len(encode_cursor(datetime.now(UTC), uuid4())) < MAX_CURSOR_LENGTH // 50


def test_rota_responde_422_ao_cursor_aninhado(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    response = api.get("/api/v1/recordings", params={"cursor": ANINHADO})
    assert response.status_code == 422, response.text
    assert "cursor" in response.text
