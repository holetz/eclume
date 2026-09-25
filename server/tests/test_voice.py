"""Identificação por voz: opt-in, consentimento, sugestão, confirmação, recusa, LGPD e isolamento."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy import text

from eclume_server.voice import DEFAULT_TERM_VERSION, DEFAULT_THRESHOLD
from eclume_server_testing.api import audio_bytes, upload_file
from eclume_server_testing.fakes import DEFAULT_VOICES, EMBEDDING_DIMS, run_cpu, run_gpu, transcribed, voice
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable
    from uuid import UUID

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services


def _sql(services: Services, sql: str, **params: Any) -> list[tuple[Any, ...]]:  # noqa: ANN401
    async def go(conn: Any) -> list[tuple[Any, ...]]:  # noqa: ANN401
        result = await conn.execute(text(sql), params)
        return [tuple(row) for row in result] if result.returns_rows else []

    return run(services.sql(go))


class Org:
    """Uma organização de teste com admin, dono de gravações e helpers de voz."""

    def __init__(self, services: Services, admin: Api, owner: Account, owner_api: Api) -> None:
        """Admin e dono (membro) da mesma organização."""
        self.services, self.admin, self.owner, self.owner_id = services, admin, owner_api, owner.user_id

    def opt_in(self, *, enabled: bool = True) -> None:
        """Liga (ou desliga) o opt-in pelo admin."""
        response = self.admin.patch("/api/v1/admin/settings", json={"voice_identification": {"enabled": enabled}})
        assert response.status_code == 200, response.text

    def person(self, name: str, *, consent: bool = True) -> dict[str, Any]:
        """Cadastra a pessoa e, por padrão, registra o consentimento."""
        person = self.owner.post("/api/v1/people", json={"name": name}).json()
        if consent:
            granted = self.owner.put(f"/api/v1/people/{person['id']}/voice-consent", json={"status": "granted"})
            assert granted.status_code == 200, granted.text
        return person

    def transcript(self, voices: dict[str, list[float]] | None = None) -> str:
        """Uma gravação transcrita do dono; devolve o id da transcrição."""
        recording = transcribed(self.owner, self.services.settings, voices=voices)
        return recording["transcript_id"]

    def link(self, tid: str, speaker: str, person_id: str | None) -> dict[str, Any]:
        """Liga (ou desliga, com `None`) o locutor à pessoa."""
        response = self.owner.patch(f"/api/v1/transcripts/{tid}/speakers/{speaker}", json={"person_id": person_id})
        assert response.status_code == 200, response.text
        return response.json()

    def speakers(self, tid: str) -> dict[str, dict[str, Any]]:
        """Locutores da transcrição por id."""
        return {s["id"]: s for s in self.owner.get(f"/api/v1/transcripts/{tid}").json()["speakers"]}

    def samples(self, person_id: str) -> int:
        """Amostras da impressão da pessoa."""
        return self.owner.get(f"/api/v1/people/{person_id}/voiceprint").json()["sample_count"]

    def events(self, person_id: str | None = None) -> list[str]:
        """Eventos da auditoria, do mais novo ao mais antigo."""
        params = {"person": person_id, "limit": 200} if person_id else {"limit": 200}
        return [e["event"] for e in self.admin.get("/api/v1/admin/voice-audit", params=params).json()["items"]]


@pytest.fixture
def new_org(
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    make_org: Callable[[], UUID],
    services: Services,
) -> Callable[[], Org]:
    def make() -> Org:
        org_id = make_org()
        owner = make_user(org_id=org_id)
        return Org(services, as_user(make_user(role="admin", org_id=org_id)), owner, as_user(owner))

    return make


@pytest.fixture
def ek(new_org: Callable[[], Org]) -> Org:
    return new_org()


def test_sem_opt_in_nada_e_comparado_nem_guardado(ek: Org, services: Services):
    rafael = ek.person("Rafael Lima")
    first = ek.transcript()
    ek.link(first, "S2", rafael["id"])
    assert ek.samples(rafael["id"]) == 0
    second = ek.transcript()
    assert all(s["suggestions"] == [] for s in ek.speakers(second).values())
    assert _sql(services, "SELECT count(*) FROM speaker_embeddings WHERE transcript_id = :t", t=second) == [(0,)]
    assert ek.events() == ["consent_granted"]
    settings = ek.admin.get("/api/v1/admin/settings").json()["voice_identification"]
    assert settings["enabled"] is False
    assert settings["suggestion_threshold"] == DEFAULT_THRESHOLD
    assert settings["consent_term_version"] == DEFAULT_TERM_VERSION


def test_sem_consentimento_nada_e_comparado_nem_guardado(ek: Org):
    ek.opt_in()
    rafael = ek.person("Rafael Lima", consent=False)
    ek.link(ek.transcript(), "S2", rafael["id"])
    assert ek.samples(rafael["id"]) == 0
    assert all(s["suggestions"] == [] for s in ek.speakers(ek.transcript()).values())
    assert "sample_added" not in ek.events()


def test_sugere_acima_do_limiar_e_a_confirmacao_reforca(ek: Org):
    ek.opt_in()
    rafael = ek.person("Rafael Lima")
    ek.link(ek.transcript(), "S2", rafael["id"])
    assert ek.samples(rafael["id"]) == 1

    # A mesma voz com ruído, noutra reunião: sugerida, nunca ligada.
    close = dict(DEFAULT_VOICES, S2=voice(2, jitter=0.5, jitter_seed=1))
    second = ek.transcript(close)
    speakers = ek.speakers(second)
    assert speakers["S2"]["person"] is None
    [suggestion] = speakers["S2"]["suggestions"]
    assert suggestion["person"] == {"id": rafael["id"], "name": "Rafael Lima"}
    assert DEFAULT_THRESHOLD <= suggestion["score"] <= 1
    assert speakers["S1"]["suggestions"] == speakers["S3"]["suggestions"] == []

    accepted = ek.link(second, "S2", rafael["id"])
    assert (accepted["person"]["name"], accepted["suggestions"]) == ("Rafael Lima", [])
    assert ek.samples(rafael["id"]) == 2
    events = ek.events(rafael["id"])
    assert {"consent_granted", "sample_added", "suggested", "accepted"} <= set(events)
    assert "comparison" in ek.events()

    # Voz diferente: abaixo do limiar, nenhuma sugestão.
    far = dict(DEFAULT_VOICES, S2=voice(99))
    assert ek.speakers(ek.transcript(far))["S2"]["suggestions"] == []


def test_sugestoes_em_ordem_de_score(ek: Org):
    ek.opt_in()
    rafael, juliana = ek.person("Rafael Lima"), ek.person("Juliana Prado")
    first = ek.transcript()
    ek.link(first, "S2", rafael["id"])
    ek.link(first, "S3", juliana["id"])
    # S2 da reunião nova soa como os dois; o Rafael mais.
    mixed = [a + 0.8 * b for a, b in zip(DEFAULT_VOICES["S2"], DEFAULT_VOICES["S3"], strict=True)]
    second = ek.transcript(dict(DEFAULT_VOICES, S2=mixed, S3=voice(50)))
    suggestions = ek.speakers(second)["S2"]["suggestions"]
    assert [s["person"]["name"] for s in suggestions] == ["Rafael Lima", "Juliana Prado"]
    assert suggestions[0]["score"] > suggestions[1]["score"]
    # Ligado, o locutor não mostra mais sugestão.
    assert ek.link(second, "S2", juliana["id"])["suggestions"] == []


def test_opt_in_desligado_esconde_sugestoes(ek: Org):
    ek.opt_in()
    rafael = ek.person("Rafael Lima")
    ek.link(ek.transcript(), "S2", rafael["id"])
    second = ek.transcript()
    assert ek.speakers(second)["S2"]["suggestions"]
    ek.opt_in(enabled=False)
    assert ek.speakers(second)["S2"]["suggestions"] == []
    assert ek.events()[:2] == ["embeddings_purged", "org_opt_in_changed"]


def test_recusar_sugestao(ek: Org):
    ek.opt_in()
    rafael = ek.person("Rafael Lima")
    ek.link(ek.transcript(), "S2", rafael["id"])
    second = ek.transcript()
    base = f"/api/v1/transcripts/{second}"
    revision = ek.owner.get(base).json()["revision"]
    url = f"{base}/speakers/S2/suggestions/{rafael['id']}"

    assert ek.owner.pat("transcripts:write").delete(url).status_code == 403
    assert ek.admin.delete(url).status_code in {403, 404}
    rejected = ek.owner.delete(url)
    assert rejected.status_code == 200, rejected.text
    assert (rejected.json()["id"], rejected.json()["suggestions"]) == ("S2", [])
    assert ek.owner.get(base).json()["revision"] == revision + 1
    assert ek.owner.delete(url).status_code == 404
    assert ek.speakers(second)["S2"]["suggestions"] == []
    assert "rejected" in ek.events(rafael["id"])
    assert ek.samples(rafael["id"]) == 1


def test_desligar_e_religar_removem_a_contribuicao(ek: Org):
    ek.opt_in()
    rafael, juliana = ek.person("Rafael Lima"), ek.person("Juliana Prado")
    tid = ek.transcript()
    ek.link(tid, "S2", rafael["id"])
    assert ek.samples(rafael["id"]) == 1
    ek.link(tid, "S2", None)
    assert ek.samples(rafael["id"]) == 0
    ek.link(tid, "S2", rafael["id"])
    ek.link(tid, "S2", juliana["id"])
    assert (ek.samples(rafael["id"]), ek.samples(juliana["id"])) == (0, 1)
    assert ek.events(rafael["id"]).count("sample_removed") == 2
    # Mesclar leva a amostra do locutor que some.
    ek.owner.post(
        f"/api/v1/transcripts/{tid}/speakers/merge", json={"source_speaker_ids": ["S2"], "target_speaker_id": "S1"}
    )
    assert ek.samples(juliana["id"]) == 0


def test_revogar_apaga_a_impressao_e_as_sugestoes(ek: Org):
    ek.opt_in()
    rafael = ek.person("Rafael Lima")
    ek.link(ek.transcript(), "S2", rafael["id"])
    second = ek.transcript()
    assert ek.speakers(second)["S2"]["suggestions"]

    revoked = ek.owner.put(
        f"/api/v1/people/{rafael['id']}/voice-consent", json={"status": "revoked", "notes": "Pediu por e-mail."}
    )
    assert revoked.status_code == 200
    consent = revoked.json()["voice_consent"]
    assert (consent["status"], consent["term_version"], consent["sample_count"]) == ("revoked", "1", 0)
    assert consent["recorded_by"]["name"]
    assert ek.speakers(second)["S2"]["suggestions"] == []
    # Revogado, ligar não cria amostra.
    ek.link(second, "S2", rafael["id"])
    assert ek.samples(rafael["id"]) == 0
    assert ek.owner.put(f"/api/v1/people/{rafael['id']}/voice-consent", json={"status": "none"}).status_code == 422
    assert (
        ek.owner.pat("people:write")
        .put(f"/api/v1/people/{rafael['id']}/voice-consent", json={"status": "granted"})
        .status_code
        == 403
    )


def test_excluir_a_impressao_mantem_o_consentimento(ek: Org):
    ek.opt_in()
    rafael = ek.person("Rafael Lima")
    ek.link(ek.transcript(), "S2", rafael["id"])
    ek.link(ek.transcript(), "S2", rafael["id"])
    assert ek.samples(rafael["id"]) == 2
    voiceprint = ek.owner.get(f"/api/v1/people/{rafael['id']}/voiceprint").json()
    assert {s["speaker_id"] for s in voiceprint["samples"]} == {"S2"}
    assert all("embedding" not in s for s in voiceprint["samples"])
    assert ek.owner.delete(f"/api/v1/people/{rafael['id']}/voiceprint").status_code == 204
    assert ek.samples(rafael["id"]) == 0
    assert ek.owner.get(f"/api/v1/people/{rafael['id']}").json()["voice_consent"]["status"] == "granted"
    assert "voiceprint_deleted" in ek.events(rafael["id"])


def test_exportacao_traz_consentimentos_amostras_e_auditoria(ek: Org):
    ek.opt_in()
    rafael = ek.person("Rafael Lima")
    ek.link(ek.transcript(), "S2", rafael["id"])
    url = f"/api/v1/people/{rafael['id']}/voiceprint/export"
    assert ek.owner.get(url).status_code == 403
    response = ek.admin.get(url)
    assert response.status_code == 200
    assert response.headers["content-disposition"] == 'attachment; filename="voz-rafael-lima.json"'
    body = response.json()
    assert body["person"]["name"] == "Rafael Lima"
    [consent] = body["consents"]
    assert (consent["status"], consent["term_version"]) == ("granted", "1")
    assert "LGPD" in consent["term_text"]
    [sample] = body["samples"]
    assert len(sample["embedding"]) == EMBEDDING_DIMS
    assert {"exported", "sample_added", "consent_granted"} <= {e["event"] for e in body["audit"]}


def test_termo_novo_sobe_a_versao(ek: Org):
    changed = ek.admin.patch(
        "/api/v1/admin/settings", json={"voice_identification": {"consent_term_text": "Termo revisto pelo jurídico."}}
    )
    assert changed.json()["voice_identification"]["consent_term_version"] == "2"
    rafael = ek.person("Rafael Lima")
    assert ek.owner.get(f"/api/v1/people/{rafael['id']}").json()["voice_consent"]["term_version"] == "2"
    body = ek.admin.get(f"/api/v1/people/{rafael['id']}/voiceprint/export").json()
    assert body["consents"][0]["term_text"] == "Termo revisto pelo jurídico."
    assert ek.events()[-1] == "org_opt_in_changed"


def test_purga_da_organizacao(ek: Org):
    ek.opt_in()
    rafael, juliana = ek.person("Rafael Lima"), ek.person("Juliana Prado")
    tid = ek.transcript()
    ek.link(tid, "S2", rafael["id"])
    ek.link(tid, "S3", juliana["id"])
    ek.transcript()
    assert ek.owner.delete("/api/v1/admin/voiceprints").status_code == 403
    purged = ek.admin.delete("/api/v1/admin/voiceprints")
    assert purged.json() == {"deleted_samples": 2, "deleted_suggestions": 2}
    assert ek.samples(rafael["id"]) == ek.samples(juliana["id"]) == 0
    assert ek.events()[0] == "org_purged"


def test_auditoria_so_para_admin_e_paginada(ek: Org):
    ek.opt_in()
    rafael = ek.person("Rafael Lima")
    ek.link(ek.transcript(), "S2", rafael["id"])
    assert ek.owner.get("/api/v1/admin/voice-audit").status_code == 403
    first = ek.admin.get("/api/v1/admin/voice-audit", params={"limit": 2}).json()
    assert len(first["items"]) == 2
    assert first["next_cursor"]
    rest = ek.admin.get("/api/v1/admin/voice-audit", params={"limit": 200, "cursor": first["next_cursor"]}).json()
    ids = [e["id"] for e in first["items"] + rest["items"]]
    assert len(ids) == len(set(ids))
    assert all(
        e["person"]["id"] == rafael["id"]
        for e in ek.admin.get("/api/v1/admin/voice-audit", params={"person": rafael["id"]}).json()["items"]
    )


def test_outra_organizacao_nunca_e_comparada(new_org: Callable[[], Org], services: Services):
    ek, other = new_org(), new_org()
    for org in (ek, other):
        org.opt_in()
    stranger = other.person("Pessoa de fora")
    other.link(other.transcript(), "S2", stranger["id"])
    assert other.samples(stranger["id"]) == 1
    # A mesma voz na outra organização: nenhuma sugestão, nenhuma leitura.
    assert all(s["suggestions"] == [] for s in ek.speakers(ek.transcript()).values())
    assert ek.owner.get(f"/api/v1/people/{stranger['id']}/voiceprint").status_code == 404
    assert ek.admin.get(f"/api/v1/people/{stranger['id']}/voiceprint/export").status_code == 404
    assert ek.admin.delete("/api/v1/admin/voiceprints").json()["deleted_samples"] == 0
    assert other.samples(stranger["id"]) == 1

    ek_org = _sql(services, "SELECT org_id FROM users WHERE id = :u", u=ek.owner_id)[0][0]

    async def as_app(conn: Any) -> list[int]:  # noqa: ANN401
        await conn.execute(text("SET LOCAL ROLE eclume_app"))
        await conn.execute(
            text("SELECT set_config('app.org_id', :org, true), set_config('app.user_id', :user, true)"),
            {"org": str(ek_org), "user": str(ek.owner_id)},
        )
        sql = "SELECT count(*) FROM {} WHERE person_id = :p"
        return [
            (await conn.execute(text(sql.format(table)), {"p": stranger["id"]})).scalar()
            for table in ("voice_samples", "speaker_suggestions", "voice_consents", "voice_audit")
        ]

    assert run(services.sql(as_app)) == [0, 0, 0, 0]
    assert _sql(services, "SELECT count(*) FROM voice_samples WHERE person_id = :p", p=stranger["id"]) == [(1,)]


def test_retranscricao_restaura_os_vinculos(ek: Org, services: Services):
    ek.opt_in()
    rafael, mariana = ek.person("Rafael Lima"), ek.person("Mariana Couto", consent=False)
    recording = transcribed(ek.owner, services.settings)
    tid = recording["transcript_id"]
    ek.link(tid, "S2", rafael["id"])
    ek.link(tid, "S1", mariana["id"])
    assert ek.samples(rafael["id"]) == 1

    response = ek.owner.post(f"/api/v1/recordings/{recording['id']}/retranscribe", json={})
    assert response.status_code in {200, 202}, response.text
    run_gpu(services.settings)
    run_cpu(services.settings)
    speakers = ek.speakers(tid)
    assert (speakers["S2"]["person"]["id"], speakers["S2"]["label"]) == (rafael["id"], "Rafael Lima")
    assert speakers["S1"]["person"]["id"] == mariana["id"]
    assert speakers["S3"]["person"] is None
    assert ek.samples(rafael["id"]) == 1
    assert ek.samples(mariana["id"]) == 0
    assert _sql(
        services,
        "SELECT count(*) FROM voice_samples s LEFT JOIN speakers sp USING (transcript_id, speaker_id) WHERE sp.person_id IS NULL",
    ) == [(0,)]
    assert ek.events(rafael["id"]).count("link_restored") == 1


# --- LGPD: purga dos embeddings por gravação e exclusão completa ----------------------------------


def _recording_of(services: Services, tid: str) -> str:
    return str(_sql(services, "SELECT recording_id FROM transcripts WHERE id = :t", t=tid)[0][0])


def _objects(services: Services, prefix: str) -> list[str]:
    listed = services.s3().list_objects_v2(Bucket=services.settings.s3_bucket, Prefix=prefix)
    return [obj["Key"] for obj in listed.get("Contents", [])]


def _embeddings(services: Services, tid: str) -> int:
    return _sql(services, "SELECT count(*) FROM speaker_embeddings WHERE transcript_id = :t", t=tid)[0][0]


def test_desligar_o_opt_in_purga_os_embeddings_so_da_organizacao(
    ek: Org, new_org: Callable[[], Org], services: Services
):
    other = new_org()
    for org in (ek, other):
        org.opt_in()
    rafael = ek.person("Rafael Lima")
    ek.link(ek.transcript(), "S2", rafael["id"])
    tid = ek.transcript()
    assert ek.speakers(tid)["S2"]["suggestions"]
    other_tid = other.transcript()
    rid, other_rid = _recording_of(services, tid), _recording_of(services, other_tid)
    embeddings_key = f"recordings/{rid}/speaker_embeddings.json"
    assert _embeddings(services, tid) == 3
    assert _objects(services, embeddings_key) == [embeddings_key]

    ek.opt_in(enabled=False)
    assert _sql(
        services,
        "SELECT count(*) FROM speaker_embeddings WHERE org_id = (SELECT org_id FROM transcripts WHERE id = :t)",
        t=tid,
    ) == [(0,)]
    assert _sql(
        services, "SELECT count(*) FROM speaker_suggestions WHERE transcript_id = :t AND status = 'pending'", t=tid
    ) == [(0,)]
    purged = ek.admin.get("/api/v1/admin/voice-audit").json()["items"][0]
    assert purged["event"] == "embeddings_purged"
    assert purged["details"]["deleted_embeddings"] >= 3
    assert purged["details"]["deleted_suggestions"] >= 1
    # A amostra de quem consentiu fica; revogá-la é o fluxo de consentimento.
    assert ek.samples(rafael["id"]) == 1

    run_cpu(services.settings)
    assert _objects(services, embeddings_key) == []
    assert _objects(services, f"recordings/{rid}/transcript.raw.json")  # só os embeddings saem
    assert _embeddings(services, other_tid) == 3
    assert _objects(services, f"recordings/{other_rid}/speaker_embeddings.json")


def test_ingestao_com_opt_in_desligado_no_meio_nao_guarda_embeddings(ek: Org, services: Services):
    ek.opt_in()
    recording = upload_file(ek.owner, audio_bytes(2100))
    job = _sql(
        services, "SELECT options ->> 'embeddings' FROM transcription_jobs WHERE recording_id = :r", r=recording["id"]
    )
    assert job == [("true",)]
    ek.opt_in(enabled=False)
    run_gpu(services.settings)
    run_cpu(services.settings)
    tid = ek.owner.get(f"/api/v1/recordings/{recording['id']}").json()["transcript_id"]
    assert _embeddings(services, tid) == 0
    assert _objects(services, f"recordings/{recording['id']}/speaker_embeddings.json") == []


def test_excluir_a_gravacao_apaga_audio_transcricao_embeddings_amostras_e_resumos(ek: Org, services: Services):
    ek.opt_in()
    rafael = ek.person("Rafael Lima")
    tid = ek.transcript()
    ek.link(tid, "S2", rafael["id"])
    ek.admin.post("/api/v1/admin/agent-providers", json={"name": "Claude", "kind": "claude-cli", "model": "sonnet"})
    templates = ek.owner.get("/api/v1/summary-templates").json()["items"]
    summary = ek.owner.post(f"/api/v1/transcripts/{tid}/summaries", json={"template_id": templates[0]["id"]})
    assert summary.status_code == 202, summary.text
    run_cpu(services.settings)
    rid = _recording_of(services, tid)
    audio_key = _sql(services, "SELECT audio_key FROM recordings WHERE id = :r", r=rid)[0][0]
    counts = """
        SELECT (SELECT count(*) FROM transcripts WHERE id = :t),
               (SELECT count(*) FROM segments WHERE transcript_id = :t),
               (SELECT count(*) FROM speakers WHERE transcript_id = :t),
               (SELECT count(*) FROM speaker_embeddings WHERE transcript_id = :t),
               (SELECT count(*) FROM voice_samples WHERE transcript_id = :t),
               (SELECT count(*) FROM summaries WHERE transcript_id = :t),
               (SELECT count(*) FROM transcription_jobs WHERE recording_id = :r)
    """
    assert all(n > 0 for n in _sql(services, counts, t=tid, r=rid)[0])
    assert _objects(services, audio_key)
    assert len(_objects(services, f"recordings/{rid}/")) == 2  # transcrição bruta e embeddings

    assert ek.owner.delete(f"/api/v1/recordings/{rid}").status_code == 204
    assert _sql(services, counts, t=tid, r=rid) == [(0, 0, 0, 0, 0, 0, 0)]
    assert _objects(services, audio_key) == []
    assert _objects(services, f"recordings/{rid}/") == []
