"""Every problem code the server raises is catalogued, in `problems.CODES` and in the contract.

Clients localize errors by `code` (docs/standards/code/i18n.md), so a code missing from the contract's
`ProblemCode` enum is a code no client can translate. The scan is static: it reads every call that
builds an `ApiProblemError` (directly or through `conflict`) in `server/src`, resolving codes held in
module constants, and the literal `detail` of every problem helper, which must be English.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Any

import pytest
import yaml

from eclume_server import problems

SOURCE = Path(problems.__file__).resolve().parent
BUNDLE = Path(__file__).resolve().parents[2] / "contracts" / "openapi-v1.bundled.yaml"
# The helper and the position of its `detail` argument.
DETAIL_ARG = {
    "forbidden": 0,
    "not_found": 0,
    "conflict": 0,
    "rate_limited": 0,
    "unsupported_media_type": 0,
    "unauthorized": 0,
    "invalid_field": 1,
    "ApiProblemError": 2,
}
# Codes built at run time, with every value they can take.
DYNAMIC = {"f\"action_{row['status']}\"": {"action_expired", "action_cancelled"}}
# Codes the exception handlers emit for errors raised by the framework.
FRAMEWORK = {"not_found", "method_not_allowed", "error", "validation_failed", "internal_error", "conflict"}
PORTUGUESE = re.compile(r"[ãâáàçéêíóôõú]", re.IGNORECASE)


def _constants(trees: dict[Path, ast.Module]) -> dict[str, str]:
    """Module-level `NAME = "text"` constants of the whole package (codes are imported across modules)."""
    found: dict[str, str] = {}
    for tree in trees.values():
        for node in tree.body:
            if (
                isinstance(node, ast.Assign)
                and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name)
                and isinstance(node.value, ast.Constant)
                and isinstance(node.value.value, str)
            ):
                found.setdefault(node.targets[0].id, node.value.value)
    return found


def _calls(trees: dict[Path, ast.Module]) -> list[tuple[str, ast.Call]]:
    calls = []
    for path, tree in trees.items():
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                name = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, "attr", None)
                if name in DETAIL_ARG:
                    calls.append((f"{path.relative_to(SOURCE)}:{node.lineno}", node))
    return calls


def _name(call: ast.Call) -> str:
    return call.func.id if isinstance(call.func, ast.Name) else call.func.attr  # type: ignore[attr-defined]


@pytest.fixture(scope="module")
def trees() -> dict[Path, ast.Module]:
    return {path: ast.parse(path.read_text(encoding="utf-8")) for path in sorted(SOURCE.rglob("*.py"))}


@pytest.fixture(scope="module")
def contract_codes() -> set[str]:
    bundle: dict[str, Any] = yaml.safe_load(BUNDLE.read_text(encoding="utf-8"))
    return set(bundle["components"]["schemas"]["ProblemCode"]["enum"])


def raised_codes(trees: dict[Path, ast.Module]) -> dict[str, list[str]]:
    """Each code raised in `server/src`, with where it is raised."""
    constants = _constants(trees)
    codes: dict[str, list[str]] = {code: ["exception handlers"] for code in FRAMEWORK}
    for where, call in _calls(trees):
        name = _name(call)
        arg: ast.expr | None = None
        # `ApiProblemError(status, code, …)` and `conflict(detail, code)`: the code is the second argument.
        if name in {"ApiProblemError", "conflict"} and len(call.args) >= 2:
            arg = call.args[1]
        arg = next((kw.value for kw in call.keywords if kw.arg == "code"), arg)
        if arg is None:
            continue
        if isinstance(arg, ast.Constant):
            values = {arg.value}
        elif isinstance(arg, ast.Name) and arg.id in constants:
            values = {constants[arg.id]}
        elif isinstance(arg, ast.Name) and arg.id == "code" and where.startswith("problems.py"):
            continue  # the helpers that pass a caller's code through
        else:
            values = DYNAMIC.get(ast.unparse(arg))
            assert values is not None, f"{where}: code built at run time, add it to DYNAMIC: {ast.unparse(arg)}"
        for value in values:
            codes.setdefault(value, []).append(where)
    return codes


def test_every_raised_code_is_in_the_server_catalog_and_in_the_contract(
    trees: dict[Path, ast.Module], contract_codes: set[str]
):
    raised = raised_codes(trees)
    assert len(raised) > 20  # guards against a scan that finds nothing
    missing = {code: where for code, where in raised.items() if code not in problems.CODES}
    assert missing == {}
    assert set(problems.CODES) == contract_codes


def test_every_literal_detail_is_english(trees: dict[Path, ast.Module]):
    constants = _constants(trees)
    portuguese = []
    for where, call in _calls(trees):
        position = DETAIL_ARG[_name(call)]
        arg = call.args[position] if len(call.args) > position else None
        if isinstance(arg, ast.Name):
            text = constants.get(arg.id, "")
        elif arg is not None:
            text = " ".join(
                node.value for node in ast.walk(arg) if isinstance(node, ast.Constant) and isinstance(node.value, str)
            )
        else:
            text = ""
        if PORTUGUESE.search(text):
            portuguese.append(f"{where}: {text}")
    assert portuguese == []


def test_the_problem_body_carries_the_english_title():
    body = problems.conflict("The upload is complete.", code="upload_expired").body()
    assert body["title"] == "Upload expired"
    assert body["code"] == "upload_expired"
    assert body["type"] == "https://eclume.dev/problems/upload-expired"
