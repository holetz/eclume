"""`/admin/secrets`: só escrita, cifrados, e entregues a quem os usa (worker GPU e provider anthropic)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy import text

from eclume_server.crypto import decrypt
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import run_cpu, run_gpu
from eclume_server_testing.harness import run
from eclume_worker.secrets import open_secret

if TYPE_CHECKING:
    from collections.abc import Callable
    from uuid import UUID

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

URL = "/api/v1/admin/secrets"
HF = "hf_abcdefghijklmnopqrstuvwxyz0123456789"


def _stored(services: Services, org_id: UUID) -> dict[str, str]:
    async def go(conn: Any) -> Any:  # noqa: ANN401
        rows = await conn.execute(
            text("SELECT name, value_encrypted FROM org_secrets WHERE org_id = :org"), {"org": str(org_id)}
        )
        return dict(rows.all())

    return run(services.sql(go))


def _jobs_options(services: Services, recording_id: str) -> list[dict[str, Any]]:
    async def go(conn: Any) -> Any:  # noqa: ANN401
        rows = await conn.execute(
            text("SELECT options FROM transcription_jobs WHERE recording_id = :r"), {"r": recording_id}
        )
        return [row[0] for row in rows]

    return run(services.sql(go))


@pytest.fixture
def admin_account(make_user: Callable[..., Account]) -> Account:
    return make_user(role="admin")


@pytest.fixture
def admin(as_user: Callable[[Account], Api], admin_account: Account) -> Api:
    return as_user(admin_account)


def test_segredo_so_entra_e_nunca_volta(
    admin: Api,
    admin_account: Account,
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

    stored = _stored(services, admin_account.org_id)["hf_token"]
    assert stored.startswith("v1:")
    assert HF not in stored
    assert decrypt(services.settings, stored) == HF

    assert admin.put(f"{URL}/hf_token", json={"value": "hf_novo"}).status_code == 204
    assert decrypt(services.settings, _stored(services, admin_account.org_id)["hf_token"]) == "hf_novo"

    assert admin.put(f"{URL}/openai_api_key", json={"value": "x"}).status_code == 422
    assert admin.put(f"{URL}/hf_token", json={"value": ""}).status_code == 422
    assert admin.put(f"{URL}/hf_token", json={"value": "   "}).status_code == 422

    member = as_user(make_user())
    assert member.get(URL).status_code == 403
    assert member.put(f"{URL}/hf_token", json={"value": "x"}).status_code == 403
    assert admin.pat("recordings:write").put(f"{URL}/hf_token", json={"value": "x"}).status_code == 403

    assert admin.delete(f"{URL}/hf_token").status_code == 204
    assert admin.delete(f"{URL}/hf_token").status_code == 404
    assert admin.get(URL).json()["items"][0]["is_set"] is False


def test_token_do_hf_vai_cifrado_so_no_payload_do_job(
    admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    member = as_user(make_user())
    admin.put(f"{URL}/hf_token", json={"value": HF})
    recording = upload_file(member, audio_bytes(1800), title="Com diarização")
    ((_, _, options),) = run_gpu(services.settings)
    assert options["hf_token_encrypted"].startswith("v1:")
    assert decrypt(services.settings, options["hf_token_encrypted"]) == HF
    # O worker GPU abre o mesmo texto com a chave do ambiente dele (a mesma do server).
    opened = open_secret(
        options["hf_token_encrypted"],
        encryption_key=services.settings.encryption_key,
        secret_key=services.settings.secret_key,
    )
    assert opened == HF
    run_cpu(services.settings)
    # O que fica no banco, e aparece no job, nunca leva o segredo.
    assert all("hf_token_encrypted" not in opts for opts in _jobs_options(services, recording["id"]))


def test_provider_anthropic_sem_chave_usa_o_segredo_da_organizacao(admin: Api, services: Services):
    provider = admin.post(
        "/api/v1/admin/agent-providers", json={"name": "Anthropic", "kind": "anthropic", "model": "claude-sonnet-5"}
    )
    assert provider.status_code == 201, provider.text
    assert provider.json()["api_key_set"] is False
    provider_id = provider.json()["id"]
    recording = upload_file(admin, audio_bytes(1700), title="Resumo pela chave da organização")
    run_gpu(services.settings)
    run_cpu(services.settings)
    transcript_id = admin.get(f"/api/v1/recordings/{recording['id']}").json()["transcript_id"]
    template_id = next(t["id"] for t in admin.get("/api/v1/summary-templates").json()["items"] if t["is_default"])
    url = f"/api/v1/transcripts/{transcript_id}/summaries"

    # Sem chave nenhuma, o provider recebe `api_key` nula (e o real recusa com provider_not_configured).
    admin.post(url, json={"template_id": template_id, "provider_id": provider_id})
    ((config, _, _),) = run_cpu(services.settings).calls
    assert config.api_key is None

    admin.put(f"{URL}/anthropic_api_key", json={"value": "sk-ant-da-organizacao"})
    admin.post(url, json={"template_id": template_id, "provider_id": provider_id})
    ((config, _, _),) = run_cpu(services.settings).calls
    assert config.api_key == "sk-ant-da-organizacao"

    # A chave própria do provider tem precedência sobre a da organização.
    admin.patch(f"/api/v1/admin/agent-providers/{provider_id}", json={"api_key": "sk-ant-do-provider"})
    admin.post(url, json={"template_id": template_id, "provider_id": provider_id})
    ((config, _, _),) = run_cpu(services.settings).calls
    assert config.api_key == "sk-ant-do-provider"
