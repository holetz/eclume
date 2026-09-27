"""Identificação por voz: liga-desliga da plataforma, sugestão, confirmação, recusa, LGPD e isolamento."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy import text

from eclume_server.voice import DEFAULT_THRESHOLD
from eclume_server_testing.api import agenda_types, audio_bytes, upload_file
from eclume_server_testing.fakes import DEFAULT_VOICES, run_cpu, run_gpu, transcribed, voice
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services


def _sql(services: Services, sql: str, **params: Any) -> list[tuple[Any, ...]]:  # noqa: ANN401
    async def go(conn: Any) -> list[tuple[Any, ...]]:  # noqa: ANN401
        result = await conn.execute(text(sql), params)
        return [tuple(row) for row in result] if result.returns_rows else []

    return run(services.sql(go))


class Conta:
    """Uma conta de usuário de teste, com a sessão de admin da plataforma e helpers de voz."""

    def __init__(self, services: Services, admin: Api, owner: Account, owner_api: Api) -> None:
        """Admin da plataforma e o dono das gravações."""
        self.services, self.admin, self.owner, self.owner_id = services, admin, owner_api, owner.user_id

    def voice_on(self, *, enabled: bool = True) -> None:
        """Liga (ou desliga) a identificação por voz na plataforma, pelo admin."""
        response = self.admin.patch("/api/v1/admin/settings", json={"voice_identification": {"enabled": enabled}})
        assert response.status_code == 200, response.text

    def person(self, name: str) -> dict[str, Any]:
        """Cadastra a pessoa."""
        return self.owner.post("/api/v1/people", json={"name": name}).json()

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


@pytest.fixture
def new_account(
    admin: Api, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
) -> Callable[[], Conta]:
    def make() -> Conta:
        owner = make_user()
        return Conta(services, admin, owner, as_user(owner))

    return make


@pytest.fixture
def ek(new_account: Callable[[], Conta]) -> Conta:
    return new_account()


def test_desligada_nada_e_comparado_nem_guardado(ek: Conta, services: Services):
    rafael = ek.person("Rafael Lima")
    first = ek.transcript()
    ek.link(first, "S2", rafael["id"])
    assert ek.samples(rafael["id"]) == 0
    second = ek.transcript()
    assert all(s["suggestions"] == [] for s in ek.speakers(second).values())
    assert _sql(services, "SELECT count(*) FROM speaker_embeddings WHERE transcript_id = :t", t=second) == [(0,)]
    settings = ek.admin.get("/api/v1/admin/settings").json()["voice_identification"]
    assert settings == {"enabled": False, "suggestion_threshold": DEFAULT_THRESHOLD}
    voiceprint = ek.owner.get(f"/api/v1/people/{rafael['id']}/voiceprint").json()
    assert voiceprint == {"person_id": rafael["id"], "enabled": False, "sample_count": 0, "samples": []}


def test_ligada_a_confirmacao_vira_amostra_sem_consentimento_por_pessoa(ek: Conta):
    ek.voice_on()
    rafael = ek.person("Rafael Lima")
    ek.link(ek.transcript(), "S2", rafael["id"])
    # O aceite do aviso no cadastro cobre o consentimento de quem o usuário grava.
    voiceprint = ek.owner.get(f"/api/v1/people/{rafael['id']}/voiceprint").json()
    assert (voiceprint["enabled"], voiceprint["sample_count"]) == (True, 1)
    assert "voice_consent" not in ek.owner.get(f"/api/v1/people/{rafael['id']}").json()


def test_sugere_acima_do_limiar_e_a_confirmacao_reforca(ek: Conta):
    ek.voice_on()
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

    # Voz diferente: abaixo do limiar, nenhuma sugestão.
    far = dict(DEFAULT_VOICES, S2=voice(99))
    assert ek.speakers(ek.transcript(far))["S2"]["suggestions"] == []


def test_sugestoes_em_ordem_de_score(ek: Conta):
    ek.voice_on()
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


def test_desligada_esconde_as_sugestoes(ek: Conta):
    ek.voice_on()
    rafael = ek.person("Rafael Lima")
    ek.link(ek.transcript(), "S2", rafael["id"])
    second = ek.transcript()
    assert ek.speakers(second)["S2"]["suggestions"]
    ek.voice_on(enabled=False)
    assert ek.speakers(second)["S2"]["suggestions"] == []


def test_recusar_sugestao(ek: Conta):
    ek.voice_on()
    rafael = ek.person("Rafael Lima")
    ek.link(ek.transcript(), "S2", rafael["id"])
    second = ek.transcript()
    base = f"/api/v1/transcripts/{second}"
    revision = ek.owner.get(base).json()["revision"]
    url = f"{base}/speakers/S2/suggestions/{rafael['id']}"

    assert ek.owner.pat("transcripts:write").delete(url).status_code == 403
    # A sessão de admin não é credencial de usuário.
    assert ek.admin.delete(url).status_code == 401
    rejected = ek.owner.delete(url)
    assert rejected.status_code == 200, rejected.text
    assert (rejected.json()["id"], rejected.json()["suggestions"]) == ("S2", [])
    assert ek.owner.get(base).json()["revision"] == revision + 1
    assert ek.owner.delete(url).status_code == 404
    assert ek.speakers(second)["S2"]["suggestions"] == []
    assert ek.samples(rafael["id"]) == 1


def test_desligar_e_religar_removem_a_contribuicao(ek: Conta):
    ek.voice_on()
    rafael, juliana = ek.person("Rafael Lima"), ek.person("Juliana Prado")
    tid = ek.transcript()
    ek.link(tid, "S2", rafael["id"])
    assert ek.samples(rafael["id"]) == 1
    ek.link(tid, "S2", None)
    assert ek.samples(rafael["id"]) == 0
    ek.link(tid, "S2", rafael["id"])
    ek.link(tid, "S2", juliana["id"])
    assert (ek.samples(rafael["id"]), ek.samples(juliana["id"])) == (0, 1)
    # Mesclar leva a amostra do locutor que some.
    ek.owner.post(
        f"/api/v1/transcripts/{tid}/speakers/merge", json={"source_speaker_ids": ["S2"], "target_speaker_id": "S1"}
    )
    assert ek.samples(juliana["id"]) == 0


def test_esquecer_a_voz_apaga_amostras_e_sugestoes(ek: Conta):
    ek.voice_on()
    rafael = ek.person("Rafael Lima")
    ek.link(ek.transcript(), "S2", rafael["id"])
    ek.link(ek.transcript(), "S2", rafael["id"])
    second = ek.transcript()
    assert ek.speakers(second)["S2"]["suggestions"]
    assert ek.samples(rafael["id"]) == 2
    voiceprint = ek.owner.get(f"/api/v1/people/{rafael['id']}/voiceprint").json()
    assert {s["speaker_id"] for s in voiceprint["samples"]} == {"S2"}
    assert all("embedding" not in s for s in voiceprint["samples"])
    assert all(s["recording_title"] for s in voiceprint["samples"])

    url = f"/api/v1/people/{rafael['id']}/voiceprint"
    assert ek.owner.pat("people:write").delete(url).status_code == 403
    assert ek.owner.delete(url).status_code == 204
    assert ek.samples(rafael["id"]) == 0
    assert ek.speakers(second)["S2"]["suggestions"] == []
    # A pessoa fica; só a voz dela sai.
    assert ek.owner.get(f"/api/v1/people/{rafael['id']}").status_code == 200


def test_outra_conta_nunca_e_comparada(new_account: Callable[[], Conta], services: Services):
    ek, other = new_account(), new_account()
    ek.voice_on()
    stranger = other.person("Pessoa de fora")
    other.link(other.transcript(), "S2", stranger["id"])
    assert other.samples(stranger["id"]) == 1
    # A mesma voz na conta da EK: nenhuma sugestão, nenhuma leitura, nenhuma exclusão.
    assert all(s["suggestions"] == [] for s in ek.speakers(ek.transcript()).values())
    assert ek.owner.get(f"/api/v1/people/{stranger['id']}/voiceprint").status_code == 404
    assert ek.owner.delete(f"/api/v1/people/{stranger['id']}/voiceprint").status_code == 404
    assert other.samples(stranger["id"]) == 1

    async def as_app(conn: Any) -> list[int]:  # noqa: ANN401
        await conn.execute(text("SET LOCAL ROLE eclume_app"))
        await conn.execute(text("SELECT set_config('app.user_id', :user, true)"), {"user": str(ek.owner_id)})
        sql = "SELECT count(*) FROM {} WHERE person_id = :p"
        return [
            (await conn.execute(text(sql.format(table)), {"p": stranger["id"]})).scalar()
            for table in ("voice_samples", "speaker_suggestions")
        ]

    assert run(services.sql(as_app)) == [0, 0]
    assert _sql(services, "SELECT count(*) FROM voice_samples WHERE person_id = :p", p=stranger["id"]) == [(1,)]


def test_retranscricao_restaura_os_vinculos(ek: Conta, services: Services):
    ek.voice_on()
    rafael, mariana = ek.person("Rafael Lima"), ek.person("Mariana Couto")
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
    assert ek.samples(mariana["id"]) == 1
    assert _sql(
        services,
        "SELECT count(*) FROM voice_samples s LEFT JOIN speakers sp USING (transcript_id, speaker_id) WHERE sp.person_id IS NULL",
    ) == [(0,)]


# --- LGPD: purga dos embeddings por gravação e exclusão completa ----------------------------------


def _recording_of(services: Services, tid: str) -> str:
    return str(_sql(services, "SELECT recording_id FROM transcripts WHERE id = :t", t=tid)[0][0])


def _objects(services: Services, prefix: str) -> list[str]:
    listed = services.s3().list_objects_v2(Bucket=services.settings.s3_bucket, Prefix=prefix)
    return [obj["Key"] for obj in listed.get("Contents", [])]


def _embeddings(services: Services, tid: str) -> int:
    return _sql(services, "SELECT count(*) FROM speaker_embeddings WHERE transcript_id = :t", t=tid)[0][0]


def test_desligar_purga_os_embeddings_da_plataforma_inteira(
    ek: Conta, new_account: Callable[[], Conta], services: Services
):
    other = new_account()
    ek.voice_on()
    rafael = ek.person("Rafael Lima")
    ek.link(ek.transcript(), "S2", rafael["id"])
    tid = ek.transcript()
    assert ek.speakers(tid)["S2"]["suggestions"]
    other_tid = other.transcript()
    rid, other_rid = _recording_of(services, tid), _recording_of(services, other_tid)
    embeddings_key = f"recordings/{rid}/speaker_embeddings.json"
    assert _embeddings(services, tid) == 3
    assert _objects(services, embeddings_key) == [embeddings_key]

    ek.voice_on(enabled=False)
    # Desligar vale para todas as contas: os embeddings por gravação e as sugestões pendentes saem.
    assert _embeddings(services, tid) == _embeddings(services, other_tid) == 0
    assert _sql(services, "SELECT count(*) FROM speaker_suggestions WHERE status = 'pending'") == [(0,)]
    # As amostras (locutores confirmados) ficam; esquecer uma voz é pela pessoa.
    assert ek.samples(rafael["id"]) == 1

    run_cpu(services.settings)
    assert _objects(services, embeddings_key) == []
    assert _objects(services, f"recordings/{rid}/transcript.raw.json")  # só os embeddings saem
    assert _objects(services, f"recordings/{other_rid}/speaker_embeddings.json") == []


def test_ingestao_com_a_voz_desligada_no_meio_nao_guarda_embeddings(ek: Conta, services: Services):
    ek.voice_on()
    recording = upload_file(ek.owner, audio_bytes(2100))
    job = _sql(
        services, "SELECT options ->> 'embeddings' FROM transcription_jobs WHERE recording_id = :r", r=recording["id"]
    )
    assert job == [("true",)]
    ek.voice_on(enabled=False)
    run_gpu(services.settings)
    run_cpu(services.settings)
    tid = ek.owner.get(f"/api/v1/recordings/{recording['id']}").json()["transcript_id"]
    assert _embeddings(services, tid) == 0
    assert _objects(services, f"recordings/{recording['id']}/speaker_embeddings.json") == []


def test_excluir_a_gravacao_apaga_audio_transcricao_embeddings_amostras_e_resumos(ek: Conta, services: Services):
    ek.voice_on()
    rafael = ek.person("Rafael Lima")
    tid = ek.transcript()
    ek.link(tid, "S2", rafael["id"])
    ek.admin.post("/api/v1/admin/agent-providers", json={"name": "Claude", "kind": "claude-cli", "model": "sonnet"})
    agenda_type_id = str(agenda_types(services, ek.owner_id)[0]["id"])
    summary = ek.owner.post(f"/api/v1/transcripts/{tid}/summaries", json={"agenda_type_id": agenda_type_id})
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
