"""The product locale: normalization, `Accept-Language`, the resolution order and the account locale."""

from __future__ import annotations

import pytest

from eclume_server.locale import DEFAULT, normalize, parse_accept_language, resolve


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
