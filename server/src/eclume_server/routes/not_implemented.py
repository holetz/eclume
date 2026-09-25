"""Operações do contrato v1 que ainda não existem: respondem 501 com `code: not_implemented`.

Cada uma pertence a uma spec do épico holetz/eclume#1 e sai desta lista quando ela a implementa. O
teste de conformidade garante que implementadas + esta lista = todas as operações do contrato.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from eclume_server.problems import ApiProblemError

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from fastapi import FastAPI
    from fastapi.responses import JSONResponse

PEOPLE_SEARCH = "holetz/eclume#11 (pessoas-organizacao-e-busca)"
ADMIN = "holetz/eclume#12 (painel-admin)"

NOT_IMPLEMENTED: tuple[tuple[str, str, str], ...] = (
    ("GET", "/api/v1/admin/health", ADMIN),
    ("GET", "/api/v1/admin/invitations", ADMIN),
    ("POST", "/api/v1/admin/invitations", ADMIN),
    ("DELETE", "/api/v1/admin/invitations/{invitation_id}", ADMIN),
    ("POST", "/api/v1/auth/invitations/{invitation_token}/accept", ADMIN),
    ("GET", "/api/v1/collections", PEOPLE_SEARCH),
    ("POST", "/api/v1/collections", PEOPLE_SEARCH),
    ("PATCH", "/api/v1/collections/{collection_id}", PEOPLE_SEARCH),
    ("DELETE", "/api/v1/collections/{collection_id}", PEOPLE_SEARCH),
    ("GET", "/api/v1/people", PEOPLE_SEARCH),
    ("POST", "/api/v1/people", PEOPLE_SEARCH),
    ("GET", "/api/v1/people/{person_id}", PEOPLE_SEARCH),
    ("PATCH", "/api/v1/people/{person_id}", PEOPLE_SEARCH),
    ("DELETE", "/api/v1/people/{person_id}", PEOPLE_SEARCH),
    ("GET", "/api/v1/people/{person_id}/transcripts", PEOPLE_SEARCH),
    ("GET", "/api/v1/search", PEOPLE_SEARCH),
    ("GET", "/api/v1/tags", PEOPLE_SEARCH),
    ("PATCH", "/api/v1/transcripts/{transcript_id}/segments/{segment_id}", PEOPLE_SEARCH),
    ("POST", "/api/v1/transcripts/{transcript_id}/speakers/merge", PEOPLE_SEARCH),
    ("PATCH", "/api/v1/transcripts/{transcript_id}/speakers/{speaker_id}", PEOPLE_SEARCH),
)


def _handler(owner: str) -> Callable[[], Awaitable[JSONResponse]]:
    async def not_implemented() -> JSONResponse:
        detail = f"Operação do contrato v1 ainda não implementada; chega com a spec {owner}."
        return ApiProblemError(501, "not_implemented", detail).response()

    return not_implemented


def include_not_implemented(app: FastAPI) -> None:
    """Registra as operações pendentes (fora do schema gerado, para não passarem por implementadas)."""
    for method, path, owner in NOT_IMPLEMENTED:
        app.add_api_route(path, _handler(owner), methods=[method], include_in_schema=False)
