"""Erros RFC 9457 (`application/problem+json`) com o campo estável `code`."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from fastapi import status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

if TYPE_CHECKING:
    from fastapi import FastAPI, Request

logger = logging.getLogger(__name__)

PROBLEM_JSON = "application/problem+json"
_TYPE_BASE = "https://eclume.dev/problems/"

_TITLES = {
    "unauthorized": "Credencial ausente ou inválida",
    "insufficient_scope": "Escopo insuficiente",
    "forbidden": "Sem permissão",
    "not_found": "Não encontrado",
    "validation_failed": "Requisição inválida",
    "conflict": "Conflito com o estado atual",
    "rate_limited": "Muitas requisições",
    "upload_expired": "Upload expirado",
    "email_taken": "E-mail já cadastrado",
    "signup_closed": "Cadastro fechado",
    "notice_required": "Aviso não aceito",
    "invalid_pairing_code": "Código de pareamento inválido",
    "invalid_reset_link": "Link de redefinição inválido",
    "method_not_allowed": "Método não permitido",
    "payload_too_large": "Corpo grande demais",
    "upload_completing": "Upload sendo concluído",
    "quota_exceeded": "Cota excedida",
    "internal_error": "Erro interno",
}


class ApiProblemError(Exception):
    """Erro de API que vira um problem+json."""

    def __init__(
        self,
        status_code: int,
        code: str,
        detail: str | None = None,
        *,
        extra: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        """Problema com status, `code` estável, `detail` opcional e campos extras do corpo."""
        super().__init__(detail or code)
        self.status_code = status_code
        self.code = code
        self.detail = detail
        self.extra = extra or {}
        self.headers = headers or {}

    def body(self) -> dict[str, Any]:
        """Corpo RFC 9457."""
        body: dict[str, Any] = {
            "type": _TYPE_BASE + self.code.replace("_", "-"),
            "title": _TITLES.get(self.code, self.code),
            "status": self.status_code,
            "code": self.code,
        }
        if self.detail:
            body["detail"] = self.detail
        body.update(self.extra)
        return body

    def response(self) -> JSONResponse:
        """Resposta HTTP do problema."""
        return JSONResponse(self.body(), status_code=self.status_code, media_type=PROBLEM_JSON, headers=self.headers)


def unauthorized(
    detail: str = "Envie o cookie de sessão ou o header Authorization: Bearer eclp_...",
) -> ApiProblemError:
    """401 — sem credencial, ou credencial inválida, expirada ou revogada."""
    return ApiProblemError(401, "unauthorized", detail, headers={"WWW-Authenticate": 'Bearer realm="eclume"'})


def forbidden(detail: str) -> ApiProblemError:
    """403 — credencial válida sem permissão (papel, dono, CSRF, rota só de sessão)."""
    return ApiProblemError(403, "forbidden", detail)


def session_required() -> ApiProblemError:
    """403 — PAT numa operação que aceita só sessão do navegador."""
    return ApiProblemError(403, "session_required", "Esta operação aceita só sessão do navegador, não PAT.")


def notice_required() -> ApiProblemError:
    """403 — sessão de conta que ainda não aceitou o aviso em vigor."""
    return ApiProblemError(403, "notice_required", "Aceite o aviso em vigor em POST /api/v1/me/notice.")


def insufficient_scope(missing: list[str], *, any_of: bool = False) -> ApiProblemError:
    """403 — o PAT não tem os escopos exigidos pela operação (`any_of`: bastaria um deles)."""
    detail = (
        f"Este PAT precisa de um destes escopos: {', '.join(missing)}."
        if any_of
        else f"Este PAT não tem o escopo {', '.join(missing)}."
    )
    return ApiProblemError(403, "insufficient_scope", detail, extra={"required_scopes": missing})


def not_found(detail: str = "Recurso inexistente ou sem acesso.") -> ApiProblemError:
    """404 — não existe ou não é visível (o eclume não distingue)."""
    return ApiProblemError(404, "not_found", detail)


def validation_failed(errors: list[dict[str, str]]) -> ApiProblemError:
    """422 — corpo ou parâmetros inválidos, um item por campo."""
    return ApiProblemError(422, "validation_failed", extra={"errors": errors})


def invalid_field(field: str, message: str) -> ApiProblemError:
    """422 de um campo só."""
    return validation_failed([{"field": field, "message": message}])


def conflict(detail: str, code: str = "conflict") -> ApiProblemError:
    """409 — o estado atual impede a operação."""
    return ApiProblemError(409, code, detail)


def rate_limited(detail: str, retry_after: int | None = None) -> ApiProblemError:
    """429 — limite atingido: pedidos em aberto, ou tentativas na janela (com `Retry-After`)."""
    headers = {"Retry-After": str(retry_after)} if retry_after is not None else None
    return ApiProblemError(429, "rate_limited", detail, headers=headers)


def payload_too_large(limit: int) -> ApiProblemError:
    """413 — o corpo passou do teto da rota."""
    return ApiProblemError(
        413, "payload_too_large", f"O corpo passou do limite de {limit} bytes desta rota.", extra={"limit": limit}
    )


def internal_error() -> ApiProblemError:
    """500 — falha inesperada do servidor; o detalhe fica só no log."""
    return ApiProblemError(500, "internal_error", "Erro inesperado no servidor; tente de novo.")


def _field(loc: tuple[Any, ...]) -> str:
    parts = list(loc[1:] if loc and loc[0] in {"body", "query", "path", "header", "cookie"} else loc)
    field = ""
    for part in parts:
        if isinstance(part, int):
            field += f"[{part}]"
        else:
            field += f".{part}" if field else str(part)
    return field or "body"


async def _validation_handler(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RequestValidationError)  # noqa: S101 — registrado só para este tipo
    errors = [{"field": _field(tuple(error["loc"])), "message": error["msg"]} for error in exc.errors()]
    return validation_failed(errors).response()


async def _problem_handler(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, ApiProblemError)  # noqa: S101 — registrado só para este tipo
    return exc.response()


async def _http_handler(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, StarletteHTTPException)  # noqa: S101 — registrado só para este tipo
    code = {
        status.HTTP_404_NOT_FOUND: "not_found",
        status.HTTP_405_METHOD_NOT_ALLOWED: "method_not_allowed",
    }.get(exc.status_code, "error")
    return ApiProblemError(exc.status_code, code, str(exc.detail) if exc.detail else None).response()


async def _internal_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.error("erro não tratado em %s %s", request.method, request.url.path, exc_info=exc)
    return internal_error().response()


def install_handlers(app: FastAPI) -> None:
    """Faz todo erro da API sair como problem+json, inclusive o 500 inesperado."""
    app.add_exception_handler(ApiProblemError, _problem_handler)
    app.add_exception_handler(RequestValidationError, _validation_handler)
    app.add_exception_handler(StarletteHTTPException, _http_handler)
    app.add_exception_handler(Exception, _internal_handler)
