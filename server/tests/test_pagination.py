"""Pagination cursors: anything malformed becomes 422 `invalid cursor`, never 500."""

from __future__ import annotations

import base64
import json
from datetime import UTC, datetime
from typing import TYPE_CHECKING
from uuid import uuid4

import pytest

from eclume_server.limits import DEFAULT_LIMIT
from eclume_server.pagination import MAX_CURSOR_LENGTH, decode_cursor, decode_position, encode_cursor, encode_position
from eclume_server.problems import ApiProblemError

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api


def _raw(value: object) -> str:
    return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")


def test_valid_cursor_round_trips():
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
def test_decode_malformed_cursor_becomes_422(cursor: str):
    with pytest.raises(ApiProblemError) as caught:
        decode_cursor(cursor)
    assert caught.value.status_code == 422


@pytest.mark.parametrize("cursor", [_raw(["a", 1]), _raw(["a"]), _raw("a"), _raw({}), "lixo", "/w"])
def test_decode_malformed_position_becomes_422(cursor: str):
    with pytest.raises(ApiProblemError) as caught:
        decode_position(cursor, 2)
    assert caught.value.status_code == 422


def test_valid_position_round_trips():
    assert decode_position(encode_position("a", 2), 2) == ["a", "2"]


def _nested(levels: int) -> str:
    """`[` repeated as real JSON (lists inside lists), not a string of brackets."""
    return base64.urlsafe_b64encode(b"[" * levels + b"]" * levels).decode().rstrip("=")


NESTED = _nested(300_000)


def test_the_test_nesting_is_real_nested_json_within_the_ceiling():
    text = base64.urlsafe_b64decode(NESTED + "==").decode()
    assert len(NESTED) <= MAX_CURSOR_LENGTH
    with pytest.raises(RecursionError):
        json.loads(text)
    assert isinstance(json.loads(base64.urlsafe_b64decode(_nested(3) + "==")), list)


@pytest.mark.parametrize(
    "cursor",
    [NESTED, _nested(5), _raw([[]]), _raw(["a", ["b"]]), _raw([{"a": "b"}, "c"]), "A" * (MAX_CURSOR_LENGTH + 1)],
)
def test_nested_or_too_large_cursor_becomes_422(cursor: str):
    for decode in (decode_cursor, lambda c: decode_position(c, 2)):
        with pytest.raises(ApiProblemError) as caught:
            decode(cursor)
        assert caught.value.status_code == 422


def test_ceiling_accepts_the_largest_cursor_the_server_emits():
    name = "\U0001f600" * (DEFAULT_LIMIT // 4)
    cursor = encode_position(name, uuid4())
    assert len(cursor) <= MAX_CURSOR_LENGTH
    assert decode_position(cursor, 2)[0] == name
    assert len(encode_cursor(datetime.now(UTC), uuid4())) < 200


@pytest.mark.parametrize("name", ["a" + "\U0001f600" * 520, "c" * 6200, 'aspas " e \\ e \n', "ação"])
def test_long_or_non_ascii_name_round_trips(name: str):
    assert decode_position(encode_position(name, "x"), 2) == [name, "x"]


def test_route_answers_422_to_the_nested_cursor(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    api = as_user(make_user())
    response = api.get("/api/v1/recordings", params={"cursor": _nested(20_000)})
    assert response.status_code == 422, response.text
    assert "cursor" in response.text
