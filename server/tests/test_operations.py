"""As operações de escrita compartilhadas (MCP, API e Agente), sob a RLS do dono."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from uuid import UUID

import pytest
from arq import create_pool
from arq.connections import RedisSettings
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine

from eclume_server.db import tables as t
from eclume_server.db.session import user_tx
from eclume_server.operations import change_agenda_type, edit_collections, edit_tags, regenerate_summary
from eclume_server.problems import ApiProblemError
from eclume_server_testing.api import agenda_types
from eclume_server_testing.fakes import transcribed
from eclume_server_testing.harness import run

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

CLAUDE = {"name": "Claude (servidor)", "kind": "claude-cli", "model": "sonnet"}


def _as(services: Services, user_id: UUID, fn: Callable[[Any], Awaitable[Any]]) -> Any:  # noqa: ANN401
    async def go() -> Any:  # noqa: ANN401
        engine = create_async_engine(services.settings.database_url)
        try:
            async with user_tx(engine, user_id) as conn:
                return await fn(conn)
        finally:
            await engine.dispose()

    return run(go())


@pytest.fixture
def owner(admin: Api, make_user: Callable[..., Account]) -> Account:
    assert admin.post("/api/v1/admin/agent-providers", json=CLAUDE).status_code == 201
    return make_user()


def test_tags_acrescentadas_e_tiradas_sem_repetir(
    owner: Account, as_user: Callable[[Account], Api], services: Services
):
    api = as_user(owner)
    rid = UUID(transcribed(api, services.settings, tags=["cliente-aurora", "rascunho"])["id"])

    def tags(add: list[str], remove: list[str]) -> Any:  # noqa: ANN401
        return _as(services, owner.user_id, lambda conn: edit_tags(conn, owner.user_id, rid, add=add, remove=remove))

    assert tags(["auditoria"], ["RASCUNHO"]) is True
    assert api.get(f"/api/v1/recordings/{rid}").json()["tags"] == ["cliente-aurora", "auditoria"]
    assert tags(["auditoria"], []) is False


def test_colecoes_e_tipo_de_agenda(owner: Account, as_user: Callable[[Account], Api], services: Services):
    api = as_user(owner)
    rid = UUID(transcribed(api, services.settings)["id"])
    collection = UUID(api.post("/api/v1/collections", json={"name": "Diretoria"}).json()["id"])

    assert _as(services, owner.user_id, lambda conn: edit_collections(conn, rid, add=[collection], remove=[])) is True
    body = api.get(f"/api/v1/recordings/{rid}").json()
    assert body["collection_ids"] == [str(collection)]
    assert _as(services, owner.user_id, lambda conn: edit_collections(conn, rid, add=[collection], remove=[])) is False
    assert _as(services, owner.user_id, lambda conn: edit_collections(conn, rid, add=[], remove=[collection])) is True

    agenda = agenda_types(services, owner.user_id)[0]
    summary_id = _as(services, owner.user_id, lambda conn: change_agenda_type(conn, rid, agenda["id"]))
    assert summary_id is not None
    assert api.get(f"/api/v1/recordings/{rid}").json()["agenda_type_id"] == str(agenda["id"])


def test_gravacao_de_outra_conta_e_404(
    owner: Account, as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    rid = UUID(transcribed(as_user(owner), services.settings)["id"])
    stranger = make_user()
    with pytest.raises(ApiProblemError) as tags:
        _as(services, stranger.user_id, lambda conn: edit_tags(conn, stranger.user_id, rid, add=["x"], remove=[]))
    assert tags.value.status_code == 404
    with pytest.raises(ApiProblemError) as collections:
        _as(services, stranger.user_id, lambda conn: edit_collections(conn, rid, add=[], remove=[]))
    assert collections.value.status_code == 404


def test_regenerar_resumo_abre_versao_na_fila(owner: Account, as_user: Callable[[Account], Api], services: Services):
    rid = UUID(transcribed(as_user(owner), services.settings)["id"])

    async def regenerate(conn: Any) -> Any:  # noqa: ANN401
        redis = await create_pool(RedisSettings.from_dsn(services.settings.redis_url))
        try:
            summary_id = await regenerate_summary(conn, redis, owner.user_id, rid)
        finally:
            await redis.aclose()
        row = (await conn.execute(select(t.summaries).where(t.summaries.c.id == summary_id))).mappings().one()
        return row["status"], row["trigger"]

    assert _as(services, owner.user_id, regenerate) == ("queued", "manual")
