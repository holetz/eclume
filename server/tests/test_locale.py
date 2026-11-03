"""The product locale: normalization, `Accept-Language`, the resolution order and the account locale."""

from __future__ import annotations

import secrets
from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError

from eclume_server.accounts import NOTICE_VERSION
from eclume_server.db import tables as t
from eclume_server.locale import DEFAULT, normalize, parse_accept_language, resolve
from eclume_server_testing.api import Api
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from fastapi.testclient import TestClient

    from eclume_server_testing.api import Account
    from eclume_server_testing.harness import Services


@pytest.mark.parametrize(
    ("tag", "expected"),
    [
        ("en", "en"),
        ("en-US", "en"),
        ("EN_gb", "en"),
        ("pt", "pt-BR"),
        ("pt-BR", "pt-BR"),
        ("pt-br", "pt-BR"),
        ("pt-PT", "pt-BR"),
        ("es", None),
        ("", None),
        (None, None),
        ("*", None),
    ],
)
def test_normalize(tag: str | None, expected: str | None):
    assert normalize(tag) == expected


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7", "pt-BR"),
        ("en-US,en;q=0.9,pt-BR;q=0.8", "en"),
        ("es-ES, pt;q=0.5", "pt-BR"),
        ("en;q=0.2, pt-BR;q=0.9", "pt-BR"),
        ("pt-BR;q=0, en;q=0.1", "en"),
        ("fr, de;q=0.8", None),
        ("pt-BR;q=abc, en", "en"),
        ("", None),
        (None, None),
    ],
)
def test_parse_accept_language(header: str | None, expected: str | None):
    assert parse_accept_language(header) == expected


def test_resolution_order_is_account_then_header_then_default():
    assert resolve("pt-BR", "en-US") == "pt-BR"
    assert resolve(None, "pt-BR,en;q=0.5") == "pt-BR"
    assert resolve(None, "fr") == DEFAULT == "en"
    assert resolve(None, None) == "en"


def _signup(client: TestClient, accept_language: str | None) -> Api:
    body = {
        "name": "Paulo Andrade",
        "email": f"locale-{secrets.token_hex(4)}@example.com",
        "password": "signup-password-2026",
        "notice_version": NOTICE_VERSION,
    }
    headers = {"Accept-Language": accept_language} if accept_language else {}
    client.cookies.clear()
    response = client.post("/api/v1/auth/signup", json=body, headers=headers)
    assert response.status_code == 204, response.text
    cookies = {name: response.cookies[name] for name in ("eclume_session", "eclume_csrf")}
    client.cookies.clear()
    return Api(client, cookies=cookies)


@pytest.mark.parametrize(
    ("accept_language", "stored"),
    [("pt-BR,pt;q=0.9,en;q=0.8", "pt-BR"), ("en-US,en;q=0.9", "en"), ("fr-FR", None), (None, None)],
)
def test_signup_stores_the_accept_language_locale(client: TestClient, accept_language: str | None, stored: str | None):
    api = _signup(client, accept_language)
    assert api.get("/api/v1/me").json()["user"]["locale"] == stored


def test_an_account_without_a_choice_reads_null_and_the_column_takes_only_supported_locales(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], services: Services
):
    account = make_user()
    assert as_user(account).get("/api/v1/me").json()["user"]["locale"] is None

    async def store(conn: Any) -> None:  # noqa: ANN401
        await conn.execute(update(t.users).where(t.users.c.id == account.user_id).values(locale="es"))

    with pytest.raises(IntegrityError):
        run(services.sql(store))
