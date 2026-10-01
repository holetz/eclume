"""Idioma da transcrição por conta e por arquivo (holetz/eclume#121)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import run_cpu, run_gpu

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services


def _job_language(api: Api, services: Services, **fields: str) -> str | None:
    """Sobe um áudio e devolve o idioma que o job levou ao worker GPU."""
    upload_file(api, audio_bytes(100), **fields)
    calls = run_gpu(services.settings)
    assert len(calls) == 1, calls
    return calls[0][2]["language"]


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


def test_idioma_do_job_sai_do_arquivo_da_conta_e_do_servidor(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], admin: Api, services: Services
):
    owner = as_user(make_user())
    assert _job_language(owner, services) == "pt"
    admin.patch("/api/v1/admin/settings", json={"asr": {"default_language": "en"}})
    assert _job_language(owner, services) == "en"
    owner.patch("/api/v1/me/transcription", json={"language": "es"})
    assert _job_language(owner, services) == "es"
    assert _job_language(owner, services, language="pt-BR") == "pt"
    owner.patch("/api/v1/me/transcription", json={"language": "auto"})
    assert _job_language(owner, services) is None


def test_auto_no_arquivo_grava_o_idioma_detectado(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], services: Services
):
    owner = as_user(make_user())
    owner.patch("/api/v1/me/transcription", json={"language": "en"})
    recording = upload_file(owner, audio_bytes(1000), language="auto")
    assert recording["language"] == "auto"
    assert run_gpu(services.settings)[0][2]["language"] is None
    run_cpu(services.settings)
    # O fake da engine detecta `pt`; a gravação nunca fica com `auto`.
    assert owner.get(f"/api/v1/recordings/{recording['id']}").json()["language"] == "pt"


def test_retranscrever_aceita_auto(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], services: Services
):
    owner = as_user(make_user())
    recording = upload_file(owner, audio_bytes(1000))
    run_gpu(services.settings)
    run_cpu(services.settings)
    again = owner.post(f"/api/v1/recordings/{recording['id']}/retranscribe", json={"language": "auto"})
    assert again.status_code == 202, again.text
    assert run_gpu(services.settings)[0][2]["language"] is None
