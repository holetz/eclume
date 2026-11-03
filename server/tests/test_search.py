"""Full-text search: Portuguese without accents, filters, pagination and isolation."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy import text

from eclume_server_testing.fakes import transcribed
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services


def ids(api: Api, **params: Any) -> list[str]:  # noqa: ANN401
    response = api.get("/api/v1/search", params=params)
    assert response.status_code == 200, response.text
    return [hit["segment"]["id"] for hit in response.json()["items"]]


@pytest.fixture
def alice(as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services) -> dict[str, Any]:
    api = as_user(make_user())
    recording = transcribed(api, services.settings, recorded_at="2026-09-18T14:00:00Z", tags=["cliente-a"])
    return {"api": api, "recording": recording}


def test_portuguese_without_accents_phrase_and_exclusion(alice: dict[str, Any]):
    api, recording = alice["api"], alice["recording"]
    response = api.get("/api/v1/search", params={"q": "turmas"}).json()
    assert {hit["segment"]["id"] for hit in response["items"]} == {"seg-0009", "seg-0010", "seg-0011"}
    ranks = [hit["rank"] for hit in response["items"]]
    assert ranks == sorted(ranks, reverse=True)
    assert all(rank > 0 for rank in ranks)
    hit = next(h for h in response["items"] if h["segment"]["id"] == "seg-0011")
    assert hit["transcript"] == {
        "id": recording["transcript_id"],
        "recording_id": recording["id"],
        "title": recording["title"],
        "recorded_at": "2026-09-18T14:00:00Z",
    }
    assert hit["speaker"]["id"] == "S2"
    assert hit["highlight"] == (
        "Eu consigo fechar a lista da primeira <mark>turma</mark> até sexta e mando para você por e-mail."
    )

    assert set(ids(api, q="liderancas")) == set(ids(api, q="LIDERANÇAS")) == {"seg-0001", "seg-0010"}
    assert ids(api, q='"primeira turma"') == ["seg-0011"]
    assert set(ids(api, q="turmas -gestores")) == {"seg-0009", "seg-0011"}
    assert ids(api, q="de") == []
    assert api.get("/api/v1/search").status_code == 422
    assert api.get("/api/v1/search", params={"q": "   "}).status_code == 422


def test_pagination(alice: dict[str, Any]):
    api = alice["api"]
    seen, cursor = [], None
    while True:
        params = {"q": "turmas", "limit": 1} | ({"cursor": cursor} if cursor else {})
        page = api.get("/api/v1/search", params=params).json()
        seen += [hit["segment"]["id"] for hit in page["items"]]
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert seen == ids(api, q="turmas")
    assert api.get("/api/v1/search", params={"q": "turmas", "cursor": "lixo"}).status_code == 422


def test_highlight_does_not_carry_other_html(alice: dict[str, Any]):
    api, recording = alice["api"], alice["recording"]
    base = f"/api/v1/transcripts/{recording['transcript_id']}"
    api.patch(f"{base}/segments/seg-0009", json={"text": "Use <b>turmas</b> & \x02mais\x03 grupos"})
    hit = next(
        h for h in api.get("/api/v1/search", params={"q": "turmas"}).json()["items"] if h["segment"]["id"] == "seg-0009"
    )
    assert hit["highlight"] == "Use &lt;b&gt;<mark>turmas</mark>&lt;/b&gt; &amp; mais grupos"


def test_filters(alice: dict[str, Any], services: Services):
    api, first = alice["api"], alice["recording"]
    collection = api.post("/api/v1/collections", json={"name": "Programa"}).json()
    second = transcribed(
        api,
        services.settings,
        recorded_at="2026-09-01T10:00:00Z",
        tags=["cliente-b"],
        collection_ids=[collection["id"]],
    )
    person = api.post("/api/v1/people", json={"name": "Mariana Couto"}).json()
    for recording in (first, second):
        api.patch(f"/api/v1/transcripts/{recording['transcript_id']}/speakers/S1", json={"person_id": person["id"]})

    def recordings(**params: Any) -> list[str]:  # noqa: ANN401
        items = api.get("/api/v1/search", params={"q": "turmas"} | params).json()["items"]
        return sorted({hit["transcript"]["recording_id"] for hit in items})

    assert recordings() == sorted([first["id"], second["id"]])
    assert recordings(tag="cliente-b") == [second["id"]]
    assert recordings(collection=collection["id"]) == [second["id"]]
    assert recordings(**{"from": "2026-09-10T00:00:00Z"}) == [first["id"]]
    assert recordings(to="2026-09-10T00:00:00Z") == [second["id"]]
    assert recordings(to="2026-09-01T10:00:00Z") == []
    assert api.get("/api/v1/search", params={"q": "turmas", "from": "ontem"}).status_code == 422

    assert ids(api, q="turmas", person=person["id"]) == ["seg-0010", "seg-0010"]
    # Only `person`: the person's utterances in chronological order, without highlight.
    spoken = api.get("/api/v1/search", params={"person": person["id"]}).json()["items"]
    assert len(spoken) == 12
    assert [hit["transcript"]["recording_id"] for hit in spoken] == [second["id"]] * 6 + [first["id"]] * 6
    assert [hit["segment"]["start_ms"] for hit in spoken[:6]] == sorted(
        hit["segment"]["start_ms"] for hit in spoken[:6]
    )
    assert {hit["speaker"]["person"]["id"] for hit in spoken} == {person["id"]}
    assert all(hit["rank"] == 0 and hit["highlight"] == hit["segment"]["text"] for hit in spoken)


def test_filter_by_user_field(
    alice: dict[str, Any],
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    services: Services,
):
    api, first = alice["api"], alice["recording"]
    second = transcribed(api, services.settings, recorded_at="2026-09-01T10:00:00Z", title="Segunda")
    client = api.post("/api/v1/fields", json={"name": "Cliente", "kind": "choice", "options": ["A", "B"]}).json()
    teams = api.post("/api/v1/fields", json={"name": "Equipes", "kind": "list"}).json()
    base = "/api/v1/recordings"
    assert api.put(f"{base}/{first['id']}/fields/{client['id']}", json={"value": "A"}).status_code == 200
    assert api.put(f"{base}/{second['id']}/fields/{client['id']}", json={"value": "B"}).status_code == 200
    assert api.put(f"{base}/{second['id']}/fields/{teams['id']}", json={"value": ["rh", "ti"]}).status_code == 200

    def recordings(*field: str) -> list[str]:
        items = api.get("/api/v1/search", params={"q": "turmas", "field": list(field)}).json()["items"]
        return sorted({hit["transcript"]["recording_id"] for hit in items})

    # OR within the same field, AND across fields; a list matches per item; built-ins (title and tags) too.
    assert recordings(f"{client['id']}:A") == [first["id"]]
    assert recordings(f"{client['id']}:A", f"{client['id']}:B") == sorted([first["id"], second["id"]])
    assert recordings(f"{client['id']}:A", f"{teams['id']}:ti") == []
    assert recordings(f"{client['id']}:B", f"{teams['id']}:ti") == [second["id"]]
    title = next(f for f in api.get("/api/v1/fields").json()["items"] if f["builtin"] == "title")
    tags = next(f for f in api.get("/api/v1/fields").json()["items"] if f["builtin"] == "tags")
    assert recordings(f"{title['id']}:Segunda") == [second["id"]]
    assert recordings(f"{tags['id']}:cliente-a") == [first["id"]]
    # Only `person` also accepts the filter.
    person = api.post("/api/v1/people", json={"name": "Mariana Couto"}).json()
    api.patch(f"/api/v1/transcripts/{second['transcript_id']}/speakers/S1", json={"person_id": person["id"]})
    spoken = api.get("/api/v1/search", params={"person": person["id"], "field": f"{client['id']}:B"}).json()["items"]
    assert {hit["transcript"]["recording_id"] for hit in spoken} == {second["id"]}
    assert api.get("/api/v1/search", params={"q": "turmas", "field": "sem-dois-pontos"}).status_code == 422

    # Another account's field does not leak: its value finds nothing here, and ours finds nothing there.
    bob = as_user(make_user(name="Bob"))
    transcribed(bob, services.settings)
    assert bob.get("/api/v1/search", params={"q": "turmas", "field": f"{client['id']}:A"}).json()["items"] == []
    bob_client = bob.post("/api/v1/fields", json={"name": "Cliente", "kind": "text"}).json()
    assert recordings(f"{bob_client['id']}:A") == []


def _matches_as(services: Services, account: Account) -> int:
    """Keys that `eclume_segment_matches` returns to `eclume_app` in the account context."""

    async def go(conn: Any) -> int:  # noqa: ANN401
        await conn.execute(text("SET LOCAL ROLE eclume_app"))
        await conn.execute(text("SELECT set_config('app.user_id', :user, true)"), {"user": str(account.user_id)})
        query = "SELECT count(*) FROM eclume_segment_matches(websearch_to_tsquery('eclume_pt', 'turmas'))"
        return (await conn.execute(text(query))).scalar_one()

    return run(services.sql(go))


def test_search_never_returns_a_segment_of_another_account(
    as_user: Callable[[Account], Api],
    make_user: Callable[..., Account],
    services: Services,
):
    accounts = {name: make_user(name=name) for name in ("Alice", "Bob", "Dave")}
    apis = {name: as_user(account) for name, account in accounts.items()}
    recording = transcribed(apis["Alice"], services.settings, title="Reunião sigilosa")
    person = apis["Alice"].post("/api/v1/people", json={"name": "Rafael"}).json()
    base = f"/api/v1/transcripts/{recording['transcript_id']}"
    apis["Alice"].patch(f"{base}/speakers/S2", json={"person_id": person["id"]})
    # Dave has his own recording with the same terms.
    transcribed(apis["Dave"], services.settings)

    def finds(name: str) -> bool:
        found = [
            hit["transcript"]["recording_id"]
            for params in ({"q": "turmas"}, {"person": person["id"]}, {"q": "turmas", "person": person["id"]})
            for hit in apis[name].get("/api/v1/search", params=params).json()["items"]
        ]
        return recording["id"] in found

    assert finds("Alice")
    assert not any(finds(name) for name in ("Bob", "Dave"))
    assert apis["Bob"].pat("transcripts:read").get("/api/v1/search", params={"q": "turmas"}).json()["items"] == []
    assert len(ids(apis["Dave"], q="turmas")) == 3  # only his recording

    # The GIN function never crosses the account: it returns only the transaction user's keys.
    assert _matches_as(services, accounts["Dave"]) == 3
    assert _matches_as(services, accounts["Bob"]) == 0
    assert _matches_as(services, accounts["Alice"]) == 3
