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

_VOZ = "holetz/eclume#15"
NOT_IMPLEMENTED: tuple[tuple[str, str, str], ...] = (
    ("DELETE", "/api/v1/transcripts/{transcript_id}/speakers/{speaker_id}/suggestions/{person_id}", _VOZ),
    ("PUT", "/api/v1/people/{person_id}/voice-consent", _VOZ),
    ("GET", "/api/v1/people/{person_id}/voiceprint", _VOZ),
    ("DELETE", "/api/v1/people/{person_id}/voiceprint", _VOZ),
    ("GET", "/api/v1/people/{person_id}/voiceprint/export", _VOZ),
    ("GET", "/api/v1/admin/voice-audit", _VOZ),
    ("DELETE", "/api/v1/admin/voiceprints", _VOZ),
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
