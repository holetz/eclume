"""Gera o bundle de arquivo único do contrato v1.

A fonte do contrato são três peças: `contracts/openapi-v1.yaml`, `contracts/transcript.schema.json`
e `contracts/fixtures/`. O OpenAPI referencia o schema da transcrição por `$ref` externo e os
exemplos por `externalValue`, para que cada fixture exista uma vez só. Ferramentas como o Prism e
geradores de tipos não seguem `externalValue`, então este script gera
`contracts/openapi-v1.bundled.yaml`: um documento sem referências externas, com os `$defs`
do schema elevados a `components/schemas` e cada fixture inlinada como `value`.

Uso:
    uv run python contracts/tools/bundle.py          # regrava o bundle
    uv run python contracts/tools/bundle.py --check  # sai com 1 se o bundle estiver desatualizado
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path
from typing import Any

import yaml

CONTRACTS = Path(__file__).resolve().parent.parent
SOURCE = CONTRACTS / "openapi-v1.yaml"
SCHEMA_FILE = "./transcript.schema.json"
BUNDLE = CONTRACTS / "openapi-v1.bundled.yaml"
TRANSCRIPT_SCHEMA_NAME = "Transcript"
HEADER = (
    "# GERADO por contracts/tools/bundle.py a partir de contracts/openapi-v1.yaml,\n"
    "# contracts/transcript.schema.json e contracts/fixtures/. Não edite à mão.\n"
)


def _rewrite_ref(ref: str) -> str:
    """Traduz um `$ref` da fonte para o ponteiro equivalente dentro do bundle."""
    if ref == SCHEMA_FILE:
        return f"#/components/schemas/{TRANSCRIPT_SCHEMA_NAME}"
    for prefix in (f"{SCHEMA_FILE}#/$defs/", "#/$defs/"):
        if ref.startswith(prefix):
            return "#/components/schemas/" + ref.removeprefix(prefix)
    if ref.startswith("#/components/"):
        return ref
    msg = f"$ref sem tradução para o bundle: {ref}"
    raise ValueError(msg)


def _load_fixture(relative: str) -> Any:  # noqa: ANN401 — uma fixture é JSON ou texto
    path = (CONTRACTS / relative).resolve()
    if not path.is_relative_to(CONTRACTS / "fixtures"):
        msg = f"externalValue fora de contracts/fixtures: {relative}"
        raise ValueError(msg)
    text = path.read_text(encoding="utf-8")
    return json.loads(text) if path.suffix == ".json" else text


def _resolve(node: Any) -> Any:  # noqa: ANN401 — percorre YAML/JSON arbitrário
    """Reescreve refs e inlina `externalValue`, devolvendo uma cópia do nó."""
    if isinstance(node, list):
        return [_resolve(item) for item in node]
    if not isinstance(node, dict):
        return node
    result: dict[str, Any] = {}
    for key, value in node.items():
        if key == "$ref" and isinstance(value, str):
            result[key] = _rewrite_ref(value)
        elif key == "externalValue" and isinstance(value, str):
            result["value"] = _load_fixture(value)
        else:
            result[key] = _resolve(value)
    return result


def build() -> str:
    """Monta o bundle e devolve o texto YAML."""
    spec = yaml.safe_load(SOURCE.read_text(encoding="utf-8"))
    transcript = json.loads((CONTRACTS / SCHEMA_FILE).read_text(encoding="utf-8"))

    schemas = spec["components"]["schemas"]
    lifted = {TRANSCRIPT_SCHEMA_NAME: copy.deepcopy(transcript)}
    lifted.update(lifted[TRANSCRIPT_SCHEMA_NAME].pop("$defs"))
    lifted[TRANSCRIPT_SCHEMA_NAME].pop("$schema", None)
    collisions = sorted(set(lifted) & set(schemas))
    if collisions:
        msg = f"nomes do schema da transcrição colidem com components/schemas: {collisions}"
        raise ValueError(msg)
    schemas.update(lifted)

    bundled = _resolve(spec)
    body = yaml.safe_dump(bundled, allow_unicode=True, sort_keys=False, width=100)
    return HEADER + body


def main() -> int:
    """Grava o bundle, ou só confere que está atualizado com `--check`."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="falha se o bundle commitado estiver desatualizado")
    args = parser.parse_args()

    text = build()
    if args.check:
        current = BUNDLE.read_text(encoding="utf-8") if BUNDLE.exists() else ""
        if current != text:
            sys.stderr.write(f"{BUNDLE.relative_to(CONTRACTS.parent)} desatualizado: rode contracts/tools/bundle.py\n")
            return 1
        sys.stdout.write("bundle atualizado\n")
        return 0
    BUNDLE.parent.mkdir(parents=True, exist_ok=True)
    BUNDLE.write_text(text, encoding="utf-8")
    sys.stdout.write(f"gravado {BUNDLE.relative_to(CONTRACTS.parent)}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
