"""RFC 9457 errors (`application/problem+json`) with the stable `code` field."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

# FastAPI is imported only when a response or a handler needs it: the worker uses the errors
# (`invalid_field`, `conflict`…) without loading the web framework.
if TYPE_CHECKING:
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse

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
    "unsupported_media_type": "Tipo de arquivo não aceito",
    "upload_completing": "Upload sendo concluído",
    "quota_exceeded": "Cota excedida",
    "internal_error": "Erro interno",
}


class ApiProblemError(Exception):
    """An API error that becomes a problem+json."""

    def __init__(
        self,
        status_code: int,
        code: str,
        detail: str | None = None,
        *,
        extra: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        """Problem with a status, a stable `code`, an optional `detail` and extra body fields."""
        super().__init__(detail or code)
        self.status_code = status_code
        self.code = code
        self.detail = detail
        self.extra = extra or {}
        self.headers = headers or {}

    def body(self) -> dict[str, Any]:
        """RFC 9457 body."""
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
        """HTTP response of the problem."""
        from fastapi.responses import JSONResponse  # noqa: PLC0415

        return JSONResponse(self.body(), status_code=self.status_code, media_type=PROBLEM_JSON, headers=self.headers)


def unauthorized(
    detail: str = "Envie o cookie de sessão ou o header Authorization: Bearer eclp_...",
) -> ApiProblemError:
    """401 — no credential, or an invalid, expired or revoked credential."""
    return ApiProblemError(401, "unauthorized", detail, headers={"WWW-Authenticate": 'Bearer realm="eclume"'})


def forbidden(detail: str) -> ApiProblemError:
    """403 — valid credential without permission (role, owner, CSRF, session-only route)."""
    return ApiProblemError(403, "forbidden", detail)


def session_required() -> ApiProblemError:
    """403 — a PAT on an operation that accepts only a browser session."""
    return ApiProblemError(403, "session_required", "Esta operação aceita só sessão do navegador, não PAT.")


def notice_required() -> ApiProblemError:
    """403 — session of an account that has not yet accepted the notice in force."""
    return ApiProblemError(403, "notice_required", "Aceite o aviso em vigor em POST /api/v1/me/notice.")


def insufficient_scope(missing: list[str], *, any_of: bool = False) -> ApiProblemError:
    """403 — the PAT lacks the scopes the operation requires (`any_of`: one of them would do)."""
    detail = (
        f"Este PAT precisa de um destes escopos: {', '.join(missing)}."
        if any_of
        else f"Este PAT não tem o escopo {', '.join(missing)}."
    )
    return ApiProblemError(403, "insufficient_scope", detail, extra={"required_scopes": missing})


def not_found(detail: str = "Recurso inexistente ou sem acesso.") -> ApiProblemError:
    """404 — does not exist or is not visible (eclume does not tell them apart)."""
    return ApiProblemError(404, "not_found", detail)


def validation_failed(errors: list[dict[str, str]]) -> ApiProblemError:
    """422 — invalid body or parameters, one item per field."""
    return ApiProblemError(422, "validation_failed", extra={"errors": errors})


def invalid_field(field: str, message: str) -> ApiProblemError:
    """422 for a single field."""
    return validation_failed([{"field": field, "message": message}])


def conflict(detail: str, code: str = "conflict") -> ApiProblemError:
    """409 — the current state prevents the operation."""
    return ApiProblemError(409, code, detail)


def rate_limited(detail: str, retry_after: int | None = None) -> ApiProblemError:
    """429 — limit reached: open requests, or attempts in the window (with `Retry-After`)."""
    headers = {"Retry-After": str(retry_after)} if retry_after is not None else None
    return ApiProblemError(429, "rate_limited", detail, headers=headers)


def payload_too_large(limit: int) -> ApiProblemError:
    """413 — the body exceeded the route's ceiling."""
    return ApiProblemError(
        413, "payload_too_large", f"O corpo passou do limite de {limit} bytes desta rota.", extra={"limit": limit}
    )


def unsupported_media_type(detail: str) -> ApiProblemError:
    """415 — the file is not of a type the route accepts."""
    return ApiProblemError(415, "unsupported_media_type", detail)


def internal_error() -> ApiProblemError:
    """500 — unexpected server failure; the detail stays only in the log."""
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
    from fastapi.exceptions import RequestValidationError  # noqa: PLC0415

    assert isinstance(exc, RequestValidationError)  # noqa: S101 — registered only for this type
    errors = [{"field": _field(tuple(error["loc"])), "message": error["msg"]} for error in exc.errors()]
    return validation_failed(errors).response()


async def _problem_handler(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, ApiProblemError)  # noqa: S101 — registered only for this type
    return exc.response()


async def _http_handler(_: Request, exc: Exception) -> JSONResponse:
    from fastapi import status  # noqa: PLC0415
    from starlette.exceptions import HTTPException as StarletteHTTPException  # noqa: PLC0415

    assert isinstance(exc, StarletteHTTPException)  # noqa: S101 — registered only for this type
    code = {
        status.HTTP_404_NOT_FOUND: "not_found",
        status.HTTP_405_METHOD_NOT_ALLOWED: "method_not_allowed",
    }.get(exc.status_code, "error")
    return ApiProblemError(exc.status_code, code, str(exc.detail) if exc.detail else None).response()


async def _internal_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.error("unhandled error in %s %s", request.method, request.url.path, exc_info=exc)
    return internal_error().response()


def install_handlers(app: FastAPI) -> None:
    """Make every API error come out as problem+json, including the unexpected 500."""
    from fastapi.exceptions import RequestValidationError  # noqa: PLC0415
    from starlette.exceptions import HTTPException as StarletteHTTPException  # noqa: PLC0415

    app.add_exception_handler(ApiProblemError, _problem_handler)
    app.add_exception_handler(RequestValidationError, _validation_handler)
    app.add_exception_handler(StarletteHTTPException, _http_handler)
    app.add_exception_handler(Exception, _internal_handler)
