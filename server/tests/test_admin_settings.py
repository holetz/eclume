"""`/admin/settings`: leitura, merge por bloco, validação e a configuração chegando ao `transcribe`."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest

from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import run_cpu, run_gpu

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

URL = "/api/v1/admin/settings"


@pytest.fixture
def admin(as_user: Callable[[Account], Api], make_user: Callable[..., Account]) -> Api:
    return as_user(make_user(role="admin", name="Mariana Couto"))


def test_so_admin_com_sessao(admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    member = as_user(make_user())
    assert member.get(URL).status_code == 403
    assert member.patch(URL, json={"asr": {"model": "large-v3"}}).status_code == 403
    assert admin.pat("recordings:read").get(URL).status_code == 401


def test_leitura_e_merge_por_bloco(admin: Api):
    initial = admin.get(URL)
    assert initial.status_code == 200
    body = initial.json()
    assert body["asr"]["model"] == "large-v3-turbo"
    assert body["updated_by"] is None
    default_template = body["summarization"]["default_template_id"]
    assert default_template is not None

    patched = admin.patch(
        URL,
        json={
            "asr": {"model": "large-v3", "compute_type": "int8", "batch_size": 2},
            "diarization": {"min_speakers": 2, "max_speakers": 4},
            "summarization": {"auto_summarize": True},
        },
    )
    assert patched.status_code == 200, patched.text
    result = patched.json()
    assert result["asr"] == {**body["asr"], "model": "large-v3", "compute_type": "int8", "batch_size": 2}
    assert result["diarization"]["min_speakers"] == 2
    assert result["diarization"]["enabled"] is True
    # O merge é por campo: o template padrão gravado pela #9 continua lá.
    assert result["summarization"] == {**body["summarization"], "auto_summarize": True}
    assert result["updated_by"]["name"] == "Mariana Couto"
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
        ({"summarization": {"default_provider_id": "01928f3a-1c00-7a00-8000-000000000b01"}}, None),
        ({"summarization": {"default_template_id": "01928f3a-1c00-7a00-8000-000000000901"}}, None),
        ({"voice_identification": {"suggestion_threshold": 1.5}}, None),
    ],
)
def test_validacao(admin: Api, body: dict[str, Any], field: str | None):
    response = admin.patch(URL, json=body)
    assert response.status_code == 422, response.text
    assert response.json()["code"] == "validation_failed"
    if field is not None:
        assert field in {e["field"] for e in response.json()["errors"]}


def test_referencias_de_provider_e_template(admin: Api):
    provider = admin.post(
        "/api/v1/admin/agent-providers",
        json={
            "name": "DeepSeek",
            "kind": "openai-compatible",
            "model": "deepseek-chat",
            "base_url": "https://api.deepseek.com/v1",
        },
    ).json()
    personal = admin.post("/api/v1/summary-templates", json={"name": "Meu", "instructions": "Resuma."}).json()
    organization = admin.post(
        "/api/v1/summary-templates", json={"name": "Da org", "instructions": "Resuma.", "scope": "organization"}
    ).json()

    assert admin.patch(URL, json={"summarization": {"default_template_id": personal["id"]}}).status_code == 422
    ok = admin.patch(
        URL, json={"summarization": {"default_template_id": organization["id"], "default_provider_id": provider["id"]}}
    )
    assert ok.status_code == 200
    templates = admin.get("/api/v1/summary-templates").json()["items"]
    assert next(t for t in templates if t["id"] == organization["id"])["is_default"] is True

    admin.patch(f"/api/v1/admin/agent-providers/{provider['id']}", json={"enabled": False})
    assert admin.patch(URL, json={"summarization": {"default_provider_id": provider["id"]}}).status_code == 422
    assert admin.patch(URL, json={"summarization": {"default_provider_id": None}}).status_code == 200


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
