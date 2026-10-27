"""Conformance of the real responses with `contracts/openapi-v1.bundled.yaml`.

Every `/api/v1` response the suite produces goes through `check`: the status must be declared in the
operation, the required headers present and the JSON body valid against the **strict** schema (the
objects closed to undeclared properties, as in `contracts/tests/test_contract.py`). A request outside
the contract (invalid parameter, body or business rule)
gets 422 `validation_failed` in any operation, as in the mock (Prism), even where the operation
does not declare the 422.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from typing import TYPE_CHECKING, Any

import yaml
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

if TYPE_CHECKING:
    import httpx

BUNDLE = Path(__file__).resolve().parents[3] / "contracts" / "openapi-v1.bundled.yaml"
BUNDLE_URI = "urn:eclume:contracts:v1:bundle"
HTTP_METHODS = {"get", "put", "post", "delete", "patch"}


def strictify(node: Any) -> Any:  # noqa: ANN401 — walks arbitrary YAML
    """Closes every object schema to undeclared properties (same as the contract test)."""
    if isinstance(node, list):
        return [strictify(item) for item in node]
    if not isinstance(node, dict):
        return node
    result = {key: strictify(value) for key, value in node.items()}
    if isinstance(node.get("properties"), dict) and "additionalProperties" not in node:
        result["additionalProperties"] = False
    return result


@cache
def bundle() -> dict[str, Any]:
    """The v1 contract in a single file."""
    return yaml.safe_load(BUNDLE.read_text(encoding="utf-8"))


@cache
def _registry() -> Registry:
    return Registry().with_resource(BUNDLE_URI, Resource(contents=strictify(bundle()), specification=DRAFT202012))


def _validator(pointer: str) -> Draft202012Validator:
    return Draft202012Validator(
        {"$ref": f"{BUNDLE_URI}#{pointer}"}, registry=_registry(), format_checker=Draft202012Validator.FORMAT_CHECKER
    )


def _pointer(*parts: str) -> str:
    return "/" + "/".join(part.replace("~", "~0").replace("/", "~1") for part in parts)


@cache
def _templates() -> list[tuple[re.Pattern[str], str]]:
    """Path templates of the contract, the literal ones before the parameterized ones (`speakers/merge`)."""
    paths = sorted(bundle()["paths"], key=lambda p: (p.count("{"), -len(p)))
    return [(re.compile("^" + re.sub(r"\{[^}]+\}", "[^/]+", p) + "$"), p) for p in paths]


def operations() -> set[tuple[str, str]]:
    """`(METHOD, path)` of every operation of the contract."""
    return {(m.upper(), p) for p, item in bundle()["paths"].items() for m in item if m in HTTP_METHODS}


@dataclass
class Conformance:
    """Collector of violations and of exercised operations."""

    failures: list[str] = field(default_factory=list)

    def check(self, response: httpx.Response) -> None:
        """Validates an `/api/v1` response against the contract."""
        path = response.request.url.path
        if not path.startswith("/api/v1/"):
            return
        method = response.request.method
        template = next((tpl for regex, tpl in _templates() if regex.match(path)), None)
        where = f"{method} {path} → {response.status_code}"
        if template is None or method.lower() not in bundle()["paths"][template]:
            self.failures.append(f"{where}: operação fora do contrato")
            return
        response.read()
        operation = bundle()["paths"][template][method.lower()]
        declared = operation["responses"].get(str(response.status_code))
        if declared is None and response.status_code in {413, 422, 500}:
            # 422: request outside the contract, in any operation (as in the mock); 413 (body above
            # the ceiling) and 500 (`internal_error`) also hold in any operation.
            self._body(where, response, _pointer("components", "schemas", "Problem"))
            return
        if declared is None:
            self.failures.append(f"{where}: status não declarado ({sorted(operation['responses'])})")
            return
        base: tuple[str, ...] = ("paths", template, method.lower(), "responses", str(response.status_code))
        if "$ref" in declared:
            name = declared["$ref"].rsplit("/", 1)[-1]
            declared = bundle()["components"]["responses"][name]
            base = ("components", "responses", name)
        self._declared(where, response, declared, base)

    def _declared(self, where: str, response: httpx.Response, declared: dict[str, Any], base: tuple[str, ...]) -> None:
        for header, spec in (declared.get("headers") or {}).items():
            if spec.get("required") and header.lower() not in response.headers:
                self.failures.append(f"{where}: header obrigatório {header} ausente")
        content = declared.get("content")
        if not content:
            if response.content:
                self.failures.append(f"{where}: corpo inesperado")
            return
        media = response.headers.get("content-type", "").split(";", 1)[0].strip()
        if media not in content:
            self.failures.append(f"{where}: content-type {media!r} fora de {sorted(content)}")
        elif media.endswith("json"):
            self._body(where, response, _pointer(*base, "content", media, "schema"))

    def _body(self, where: str, response: httpx.Response, pointer: str) -> None:
        try:
            body = response.json()
        except json.JSONDecodeError:
            self.failures.append(f"{where}: corpo não é JSON")
            return
        self.failures.extend(
            f"{where} {list(error.absolute_path)}: {error.message}" for error in _validator(pointer).iter_errors(body)
        )


CONFORMANCE = Conformance()
