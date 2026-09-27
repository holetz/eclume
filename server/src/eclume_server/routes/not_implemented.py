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

_DISPOSITIVOS = "holetz/eclume#35"
NOT_IMPLEMENTED: tuple[tuple[str, str, str], ...] = (
    ("POST", "/api/v1/devices/login", _DISPOSITIVOS),
    ("POST", "/api/v1/devices/pairing-codes", _DISPOSITIVOS),
    ("GET", "/api/v1/devices/pairing-codes/{pairing_code_id}", _DISPOSITIVOS),
    ("POST", "/api/v1/devices/pair", _DISPOSITIVOS),
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
