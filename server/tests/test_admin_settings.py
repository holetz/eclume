"""`/admin/settings`: leitura, merge por bloco, validação e a configuração chegando ao `transcribe`."""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Any, get_args, get_origin

import pytest
from pydantic import BaseModel
from sqlalchemy import text

from eclume_server.settings_admin import AdminSettingsPatch
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import run_cpu, run_gpu
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

URL = "/api/v1/admin/settings"
PREPROCESSING = {
    "denoise": {"enabled": True, "method": "rnnoise", "strength": 0.6},
    "loudnorm": {"enabled": True, "target_lufs": -16, "true_peak_db": -1.5, "lra": 11},
    "trim_silence": {"enabled": True, "min_silence_s": 3, "threshold_db": -50},
    "split_channels": {"enabled": False},
}


def test_so_a_sessao_de_admin(admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    user = as_user(make_user())
    assert user.get(URL).status_code == 401
    assert user.patch(URL, json={"asr": {"model": "large-v3"}}).status_code == 401
    assert user.pat("recordings:read").get(URL).status_code == 401
    assert admin.get(URL).status_code == 200


def test_leitura_e_merge_por_bloco(admin: Api):
    initial = admin.get(URL)
    assert initial.status_code == 200
    body = initial.json()
    assert body["asr"]["model"] == "large-v3-turbo"
    assert body["updated_by"] is None
    assert "summarization" not in body
    assert body["preprocessing"] == PREPROCESSING
    assert body["voice_identification"] == {"enabled": False, "suggestion_threshold": 0.55}

    patched = admin.patch(
        URL,
        json={
            "asr": {"model": "large-v3", "compute_type": "int8", "batch_size": 2},
            "diarization": {"min_speakers": 2, "max_speakers": 4},
            "preprocessing": {"denoise": {"method": "afftdn"}, "split_channels": {"enabled": True}},
        },
    )
    assert patched.status_code == 200, patched.text
    result = patched.json()
    assert result["asr"] == {**body["asr"], "model": "large-v3", "compute_type": "int8", "batch_size": 2}
    assert result["diarization"]["min_speakers"] == 2
    assert result["diarization"]["enabled"] is True
    # O pré-processamento é mesclado por etapa: o resto de cada etapa fica.
    assert result["preprocessing"] == {
        **PREPROCESSING,
        "denoise": {**PREPROCESSING["denoise"], "method": "afftdn"},
        "split_channels": {"enabled": True},
    }
    # Quem mudou é a conta de admin, não um usuário.
    me = admin.get("/api/v1/admin/me").json()
    assert result["updated_by"] == {"id": me["id"], "name": me["name"]}
    assert admin.get(URL).json() == result

    cleared = admin.patch(URL, json={"asr": {"batch_size": None}, "diarization": {"min_speakers": None}})
    assert cleared.json()["asr"]["batch_size"] is None
    assert cleared.json()["diarization"]["min_speakers"] is None


@pytest.mark.parametrize(
    ("body", "field"),
    [
        ({}, "body"),
        ({"asr": {}}, "body"),
        ({"asr": {"compute_type": "float16"}}, None),
        ({"asr": {"engine": "gemini"}}, None),
        ({"asr": {"model": None}}, "asr.model"),
        ({"asr": {"batch_size": 0}}, None),
        ({"asr": {"engine": "openai-compatible"}}, "asr.endpoint_url"),
        ({"asr": {"endpoint_url": "ftp://speaches"}}, None),
        ({"asr": {"modelo": "x"}}, None),
        ({"diarization": {"model": "pyannote/speaker-diarization-3.1"}}, None),
        ({"diarization": {"min_speakers": 5, "max_speakers": 2}}, "diarization.min_speakers"),
        ({"diarization": {"enabled": None}}, "diarization.enabled"),
        ({"diarization": {"min_speakers": 31}}, None),
        ({"diarization": {"max_speakers": 10**30}}, None),
        ({"diarization": {"min_speakers": True}}, None),
        ({"diarization": {"max_speakers": False}}, None),
        # O resumo automático segue o tipo de agenda e o provider de `summaries`: o bloco saiu.
        ({"summarization": {"auto_summarize": True}}, None),
        ({"preprocessing": {"denoise": {"method": "spleeter"}}}, None),
        ({"preprocessing": {"denoise": {"strength": 1.2}}}, None),
        ({"preprocessing": {"loudnorm": {"target_lufs": -5}}}, None),
        ({"preprocessing": {"loudnorm": {"true_peak_db": 1}}}, None),
        ({"preprocessing": {"loudnorm": {"lra": 30}}}, None),
        ({"preprocessing": {"trim_silence": {"min_silence_s": 0.5}}}, None),
        ({"preprocessing": {"trim_silence": {"threshold_db": -10}}}, None),
        ({"preprocessing": {"resample": {"enabled": False}}}, None),
        ({"preprocessing": {"denoise": None}}, "preprocessing.denoise"),
        ({"preprocessing": {"denoise": {"enabled": None}}}, "preprocessing.denoise.enabled"),
        ({"voice_identification": {"suggestion_threshold": 1.5}}, None),
        ({"voice_identification": {"consent_term_text": "Autorizo."}}, None),
    ],
)
def test_validacao(admin: Api, body: dict[str, Any], field: str | None):
    response = admin.patch(URL, json=body)
    assert response.status_code == 422, response.text
    assert response.json()["code"] == "validation_failed"
    if field is not None:
        assert field in {e["field"] for e in response.json()["errors"]}


def _is_number(annotation: object) -> bool:
    if annotation in {int, float}:
        return True
    args = get_args(annotation)
    if get_origin(annotation) is Annotated:
        args = args[:1]
    return any(_is_number(arg) for arg in args)


def _numeric_paths(model: type[BaseModel], prefix: tuple[str, ...] = ()) -> list[tuple[str, ...]]:
    paths: list[tuple[str, ...]] = []
    for name, info in model.model_fields.items():
        nested = next((a for a in get_args(info.annotation) if isinstance(a, type) and issubclass(a, BaseModel)), None)
        if nested is not None:
            paths += _numeric_paths(nested, (*prefix, name))
        elif _is_number(info.annotation):
            paths.append((*prefix, name))
    return paths


NUMERIC_PATHS = _numeric_paths(AdminSettingsPatch)


def test_todo_campo_numerico_foi_achado():
    assert len(NUMERIC_PATHS) >= 15
    assert ("asr", "batch_size") in NUMERIC_PATHS
    assert ("preprocessing", "loudnorm", "lra") in NUMERIC_PATHS


@pytest.mark.parametrize("path", NUMERIC_PATHS, ids=[".".join(p) for p in NUMERIC_PATHS])
@pytest.mark.parametrize("value", [True, False])
def test_booleano_em_campo_numerico_e_recusado(admin: Api, path: tuple[str, ...], value: object):
    before = admin.get(URL).json()
    body: Any = value
    for key in reversed(path):
        body = {key: body}
    response = admin.patch(URL, json=body)
    assert response.status_code == 422, response.text
    assert response.json()["code"] == "validation_failed"
    assert ".".join(path) in {e["field"] for e in response.json()["errors"]}
    assert admin.get(URL).json() == before


def test_proximo_transcribe_sai_com_a_configuracao_nova(
    admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    member = as_user(make_user())
    admin.patch(
        URL,
        json={
            "asr": {"model": "large-v3", "batch_size": 2, "default_language": "en"},
            "diarization": {"enabled": False, "min_speakers": 1, "max_speakers": 3},
        },
    )
    recording = upload_file(member, audio_bytes(1500), title="Com a configuração nova")
    ((recording_id, _key, options),) = run_gpu(services.settings)
    assert recording_id == recording["id"]
    assert options["model"] == "large-v3"
    assert options["batch_size"] == 2
    assert options["language"] == "en"
    assert (options["diarize"], options["min_speakers"], options["max_speakers"]) == (False, 1, 3)
    assert "hf_token_encrypted" not in options
    run_cpu(services.settings)

    # A retranscrição também lê a configuração do momento.
    admin.patch(URL, json={"asr": {"model": "medium"}})
    assert member.post(f"/api/v1/recordings/{recording['id']}/retranscribe").status_code == 202
    ((_, _, options),) = run_gpu(services.settings)
    assert options["model"] == "medium"
    run_cpu(services.settings)


def test_idioma_automatico_vai_nulo_ao_transcribe(
    admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    assert admin.patch(URL, json={"asr": {"default_language": "auto"}}).json()["asr"]["default_language"] == "auto"
    member = as_user(make_user())
    upload_file(member, audio_bytes(1500), title="Idioma a detectar")
    ((_, _, options),) = run_gpu(services.settings)
    assert options["language"] is None
    # Um `transcribe` por conta na GPU: o próximo entra depois da ingestão deste.
    run_cpu(services.settings)
    # O idioma da gravação, quando dito, vence o automático.
    upload_file(member, audio_bytes(1600), title="Em inglês", language="en")
    ((_, _, options),) = run_gpu(services.settings)
    assert options["language"] == "en"
    run_cpu(services.settings)


def test_identificacao_por_voz_exige_a_separacao(admin: Api):
    refused = admin.patch(URL, json={"voice_identification": {"enabled": True}, "diarization": {"enabled": False}})
    assert refused.status_code == 422
    assert refused.json()["errors"][0]["field"] == "voice_identification.enabled"
    assert admin.patch(URL, json={"voice_identification": {"enabled": True}}).status_code == 200
    assert admin.patch(URL, json={"diarization": {"enabled": False}}).status_code == 422
    assert admin.patch(URL, json={"voice_identification": {"enabled": False}}).status_code == 200
    assert admin.patch(URL, json={"diarization": {"enabled": False}}).status_code == 200


def test_estado_antigo_sem_separacao_nao_trava_outro_bloco(admin: Api, services: Services):
    # Um estado de antes da regra: voz ligada com a separação desligada.
    async def legacy(conn: Any) -> None:  # noqa: ANN401
        await conn.execute(
            text(
                "UPDATE platform_settings SET"
                " voice_identification = voice_identification || '{\"enabled\": true}',"
                " diarization = diarization || '{\"enabled\": false}'"
            )
        )

    run(services.sql(legacy))
    assert admin.patch(URL, json={"asr": {"batch_size": 8}}).status_code == 200
    assert admin.patch(URL, json={"preprocessing": {"denoise": {"strength": 0.4}}}).status_code == 200
    # Tocar a separação ainda exige a regra.
    assert admin.patch(URL, json={"diarization": {"min_speakers": 2}}).status_code == 422


def test_cotas_padrao_mescladas_campo_a_campo(
    admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account]
):
    quotas = admin.get(URL).json()["quotas"]
    assert quotas == {
        "storage_bytes": 10 * 1024**3,
        "file_bytes": 2 * 1024**3,
        "open_uploads": 3,
        "gpu_minutes_24h": 600,
        "agent_requests_24h": 200,
    }
    patched = admin.patch(URL, json={"quotas": {"open_uploads": 1, "agent_requests_24h": None}})
    assert patched.status_code == 200, patched.text
    assert patched.json()["quotas"] == quotas | {"open_uploads": 1, "agent_requests_24h": None}
    # A conta sem sobreposição segue o padrão novo.
    effective = as_user(make_user()).get("/api/v1/me/usage").json()["quotas"]
    assert (effective["open_uploads"], effective["agent_requests_24h"]) == (1, None)
    assert admin.patch(URL, json={"quotas": {"open_uploads": -1}}).status_code == 422
    assert admin.patch(URL, json={"quotas": {"desconhecida": 1}}).status_code == 422
