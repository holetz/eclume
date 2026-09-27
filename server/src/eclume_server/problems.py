"""Erros RFC 9457 (`application/problem+json`) com o campo estável `code`."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from fastapi import status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

if TYPE_CHECKING:
    from fastapi import FastAPI, Request

PROBLEM_JSON = "application/problem+json"
_TYPE_BASE = "https://eclume.dev/problems/"

_TITLES = {
    "unauthorized": "Credencial ausente ou inválida",
    "insufficient_scope": "Escopo insuficiente",
    "forbidden": "Sem permissão",
    "not_found": "Não encontrado",
    "validation_failed": "Requisição inválida",
    "conflict": "Conflito com o estado atual",
    "upload_expired": "Upload expirado",
    "email_taken": "E-mail já cadastrado",
    "signup_closed": "Cadastro fechado",
    "method_not_allowed": "Método não permitido",
    "not_implemented": "Ainda não implementado",
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


def insufficient_scope(missing: list[str]) -> ApiProblemError:
    """403 — o PAT não tem os escopos exigidos pela operação."""
    return ApiProblemError(
        403,
        "insufficient_scope",
        f"Este PAT não tem o escopo {', '.join(missing)}.",
        extra={"required_scopes": missing},
    )


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


def install_handlers(app: FastAPI) -> None:
    """Faz todo erro da API sair como problem+json."""
    app.add_exception_handler(ApiProblemError, _problem_handler)
    app.add_exception_handler(RequestValidationError, _validation_handler)
    app.add_exception_handler(StarletteHTTPException, _http_handler)
