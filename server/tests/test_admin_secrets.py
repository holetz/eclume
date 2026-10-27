"""`/admin/secrets`: write-only, encrypted, and delivered to whoever uses them (GPU worker and anthropic provider)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import text

from eclume_server.crypto import decrypt
from eclume_server_testing.api import agenda_types, audio_bytes, upload_file
from eclume_server_testing.fakes import run_cpu, run_gpu
from eclume_server_testing.harness import run
from eclume_worker.secrets import open_secret

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

URL = "/api/v1/admin/secrets"
HF = "hf_abcdefghijklmnopqrstuvwxyz0123456789"


def _stored(services: Services) -> dict[str, str]:
    async def go(conn: Any) -> Any:  # noqa: ANN401
        rows = await conn.execute(text("SELECT name, value_encrypted FROM platform_secrets"))
        return dict(rows.all())

    return run(services.sql(go))


def _jobs_options(services: Services, recording_id: str) -> list[dict[str, Any]]:
    async def go(conn: Any) -> Any:  # noqa: ANN401
        rows = await conn.execute(
            text("SELECT options FROM transcription_jobs WHERE recording_id = :r"), {"r": recording_id}
        )
        return [row[0] for row in rows]

    return run(services.sql(go))


def test_secret_only_goes_in_and_never_comes_back(
    admin: Api,
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    services: Services,
):
    listed = admin.get(URL).json()["items"]
    assert listed == [
        {"name": "hf_token", "is_set": False, "updated_at": None},
        {"name": "anthropic_api_key", "is_set": False, "updated_at": None},
    ]
    assert admin.put(f"{URL}/hf_token", json={"value": HF}).status_code == 204
    after = admin.get(URL)
    assert HF not in after.text
    hf = after.json()["items"][0]
    assert hf["is_set"] is True
    assert hf["updated_at"] is not None

    stored = _stored(services)["hf_token"]
    assert stored.startswith("v1:")
    assert HF not in stored
    assert decrypt(services.settings, stored) == HF

    assert admin.put(f"{URL}/hf_token", json={"value": "hf_novo"}).status_code == 204
    assert decrypt(services.settings, _stored(services)["hf_token"]) == "hf_novo"

    assert admin.put(f"{URL}/openai_api_key", json={"value": "x"}).status_code == 422
    assert admin.put(f"{URL}/hf_token", json={"value": ""}).status_code == 422
    assert admin.put(f"{URL}/hf_token", json={"value": "   "}).status_code == 422

    user = as_user(make_user())
    assert user.get(URL).status_code == 401
    assert user.put(f"{URL}/hf_token", json={"value": "x"}).status_code == 401
    assert user.pat("recordings:write").put(f"{URL}/hf_token", json={"value": "x"}).status_code == 401

    assert admin.delete(f"{URL}/hf_token").status_code == 204
    assert admin.delete(f"{URL}/hf_token").status_code == 404
    assert admin.get(URL).json()["items"][0]["is_set"] is False


def test_hf_token_goes_encrypted_only_in_the_job_payload(
    admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    member = as_user(make_user())
    admin.put(f"{URL}/hf_token", json={"value": HF})
    recording = upload_file(member, audio_bytes(1800), title="Com diarização")
    ((_, _, options),) = run_gpu(services.settings)
    assert options["hf_token_encrypted"].startswith("v1:")
    assert decrypt(services.settings, options["hf_token_encrypted"]) == HF
    # The GPU worker opens the same text with its own environment's key (the same as the server's).
    opened = open_secret(
        options["hf_token_encrypted"],
        encryption_key=services.settings.encryption_key,
        secret_key=services.settings.secret_key,
    )
    assert opened == HF
    run_cpu(services.settings)
    # What stays in the database, and shows in the job, never carries the secret.
    assert all("hf_token_encrypted" not in opts for opts in _jobs_options(services, recording["id"]))


def test_anthropic_provider_without_key_uses_the_platform_secret(
    admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    provider = admin.post(
        "/api/v1/admin/agent-providers", json={"name": "Anthropic", "kind": "anthropic", "model": "claude-sonnet-5"}
    )
    assert provider.status_code == 201, provider.text
    assert provider.json()["api_key_set"] is False
    provider_id = provider.json()["id"]
    account = make_user()
    user = as_user(account)
    recording = upload_file(user, audio_bytes(1700), title="Resumo pela chave da plataforma")
    run_gpu(services.settings)
    run_cpu(services.settings)
    transcript_id = user.get(f"/api/v1/recordings/{recording['id']}").json()["transcript_id"]
    agenda_type_id = str(agenda_types(services, account.user_id)[0]["id"])
    url = f"/api/v1/transcripts/{transcript_id}/summaries"

    # With no key at all, the provider gets a null `api_key` (and the real one refuses with provider_not_configured).
    user.post(url, json={"agenda_type_id": agenda_type_id, "provider_id": provider_id})
    ((config, _, _),) = run_cpu(services.settings).calls
    assert config.api_key is None

    admin.put(f"{URL}/anthropic_api_key", json={"value": "sk-ant-da-plataforma"})
    user.post(url, json={"agenda_type_id": agenda_type_id, "provider_id": provider_id})
    ((config, _, _),) = run_cpu(services.settings).calls
    assert config.api_key == "sk-ant-da-plataforma"

    # The provider's own key takes precedence over the platform's.
    admin.patch(f"/api/v1/admin/agent-providers/{provider_id}", json={"api_key": "sk-ant-do-provider"})
    user.post(url, json={"agenda_type_id": agenda_type_id, "provider_id": provider_id})
    ((config, _, _),) = run_cpu(services.settings).calls
    assert config.api_key == "sk-ant-do-provider"
