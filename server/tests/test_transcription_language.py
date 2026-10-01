"""Idioma da transcrição por conta e por arquivo (holetz/eclume#121)."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api


def test_preferencia_da_conta_nasce_no_padrao_do_servidor(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], admin: Api
):
    owner = as_user(make_user())
    assert owner.get("/api/v1/me/transcription").json() == {"language": None, "platform_default": "pt"}
    admin.patch("/api/v1/admin/settings", json={"asr": {"default_language": "en"}})
    assert owner.get("/api/v1/me/transcription").json() == {"language": None, "platform_default": "en"}
    assert owner.patch("/api/v1/me/transcription", json={"language": "es"}).json() == {
        "language": "es",
        "platform_default": "en",
    }
    assert owner.patch("/api/v1/me/transcription", json={"language": "auto"}).json()["language"] == "auto"
    assert owner.patch("/api/v1/me/transcription", json={"language": None}).json()["language"] is None
    for body in ({}, {"language": "português"}, {"language": "pt", "outro": 1}):
        assert owner.patch("/api/v1/me/transcription", json=body).status_code == 422, body


def test_pat_le_a_preferencia_mas_nao_escreve(make_user: Callable[..., Account], as_user: Callable[[Account], Api]):
    owner = as_user(make_user())
    owner.patch("/api/v1/me/transcription", json={"language": "en"})
    reader = owner.pat("recordings:read")
    assert reader.get("/api/v1/me/transcription").json()["language"] == "en"
    assert reader.patch("/api/v1/me/transcription", json={"language": "pt"}).status_code == 403
    assert owner.pat("people:read").get("/api/v1/me/transcription").status_code == 403
