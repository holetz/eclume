"""Idioma da transcrição por conta e por arquivo (holetz/eclume#121)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import run_cpu, run_gpu

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services


_sizes = iter(range(100, 10_000))


def _job_language(api: Api, services: Services, **fields: str) -> str | None:
    """Sobe um áudio novo (sem deduplicar), transcreve e devolve o idioma que o job levou ao worker GPU."""
    upload_file(api, audio_bytes(next(_sizes)), **fields)
    calls = run_gpu(services.settings)
    run_cpu(services.settings)
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


def _speakers(calls: list) -> tuple[int | None, int | None]:
    options = calls[0][2]
    return options["min_speakers"], options["max_speakers"]


def test_nota_de_voz_leva_um_locutor_e_a_reuniao_os_limites_do_admin(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], admin: Api, services: Services
):
    admin.patch("/api/v1/admin/settings", json={"diarization": {"min_speakers": 2, "max_speakers": 5}})
    owner = as_user(make_user())
    upload_file(owner, audio_bytes(next(_sizes)), kind="note")
    assert _speakers(run_gpu(services.settings)) == (1, 1)
    run_cpu(services.settings)
    upload_file(owner, audio_bytes(next(_sizes)))
    assert _speakers(run_gpu(services.settings)) == (2, 5)


def test_retranscrever_com_locutores_vence_a_nota_e_o_admin(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], services: Services
):
    owner = as_user(make_user())
    recording = upload_file(owner, audio_bytes(next(_sizes)), kind="note")
    run_gpu(services.settings)
    run_cpu(services.settings)
    url = f"/api/v1/recordings/{recording['id']}/retranscribe"
    assert owner.post(url, json={"min_speakers": 3, "max_speakers": 2}).status_code == 422
    assert owner.post(url, json={"min_speakers": 0}).status_code == 422
    assert owner.post(url, json={"min_speakers": 2, "max_speakers": 3}).status_code == 202
    assert _speakers(run_gpu(services.settings)) == (2, 3)


def test_retranscribe_with_one_speaker_side_keeps_the_platform_limit_on_the_other(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], admin: Api, services: Services
):
    admin.patch("/api/v1/admin/settings", json={"diarization": {"min_speakers": 2, "max_speakers": 4}})
    owner = as_user(make_user())
    recording = upload_file(owner, audio_bytes(next(_sizes)))
    run_gpu(services.settings)
    run_cpu(services.settings)
    url = f"/api/v1/recordings/{recording['id']}/retranscribe"
    for body, expected in (
        ({"min_speakers": 3}, (3, 4)),
        ({"max_speakers": 3}, (2, 3)),
        ({"min_speakers": 5}, (5, None)),
        ({"max_speakers": 1}, (None, 1)),
    ):
        assert owner.post(url, json=body).status_code == 202
        assert _speakers(run_gpu(services.settings)) == expected, body
        run_cpu(services.settings)


def test_retranscrever_recusa_locutores_acima_do_teto_e_booleano(
    make_user: Callable[..., Account], as_user: Callable[[Account], Api], services: Services
):
    owner = as_user(make_user())
    recording = upload_file(owner, audio_bytes(next(_sizes)))
    run_gpu(services.settings)
    run_cpu(services.settings)
    url = f"/api/v1/recordings/{recording['id']}/retranscribe"
    for body in (
        {"min_speakers": 31},
        {"max_speakers": 31},
        {"min_speakers": 10**30},
        {"max_speakers": 256},
        {"min_speakers": True},
        {"max_speakers": False},
    ):
        assert owner.post(url, json=body).status_code == 422, body
    assert owner.post(url, json={"min_speakers": 30, "max_speakers": 30}).status_code == 202
