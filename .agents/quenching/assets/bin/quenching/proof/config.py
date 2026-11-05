"""Resolve the proof front's declarations without deciding whether they are healthy.

The shared specs loader owns `.agents/quenching.json`; this module owns the meaning of the proof
keys. Defaults describe the ordinary target shape (`tests/` and no declared layer), while every
path returned here is resolved against the repository root so inventory and reports never mix a
config-relative path with a proof-root-relative one.
"""
from __future__ import annotations

import os
from typing import Any

from quenching.common.config import CONFIG_FILE, find_repo_root, load_config, namespace


DEFAULT_PROOF_ROOT = "tests"
DEFAULT_RATCHET_NAME = ".coverage-floor.json"
REACHES = ("nothing", "tree", "session", "workspace")


def _repo_root(root: str) -> str:
    """Resolve the config's repository root without running a target command."""
    return find_repo_root(root)


def _resolve(repo_root: str, declared: str) -> str:
    return os.path.abspath(os.path.join(repo_root, declared))


def _relative(repo_root: str, path: str) -> str:
    return os.path.relpath(path, repo_root).replace(os.sep, "/")


def _layers(raw: Any) -> dict[str, dict[str, Any]]:
    """Keep valid layer declarations and leave malformed entries for the doctor to report."""
    if not isinstance(raw, dict):
        return {}
    result: dict[str, dict[str, Any]] = {}
    for name, value in raw.items():
        if not isinstance(name, str) or not name.strip() or not isinstance(value, dict):
            continue
        layer: dict[str, Any] = {"name": name.strip()}
        reach = value.get("reach")
        if isinstance(reach, str) and reach.strip():
            layer["reach"] = reach.strip()
        budget = value.get("budget")
        if isinstance(budget, (int, float)) and not isinstance(budget, bool) and budget > 0:
            layer["budget"] = budget
        if isinstance(value.get("required"), bool):
            layer["required"] = value["required"]
        result[name.strip()] = layer
    return dict(sorted(result.items()))


def load_proof_config(root: str) -> tuple[dict | None, dict]:
    """Return resolved proof declarations, or a refusal only for an unreadable config."""
    repo_root = _repo_root(root)
    cfg = load_config(root, detect_provider_info=False)
    if cfg.get("migrationRefusal"):
        return None, cfg["migrationRefusal"]
    proof = namespace(cfg, "proof")
    proof_root_declared = proof.get("proofRoot") or DEFAULT_PROOF_ROOT
    if not isinstance(proof_root_declared, str) or not proof_root_declared.strip():
        return None, {
            "code": "pf-config-invalid",
            "exit": 2,
            "config": CONFIG_FILE,
            "message": "`proofRoot` must be a non-empty path when declared",
        }
    proof_root = _resolve(repo_root, proof_root_declared.strip())

    ratchet_declared = proof.get("ratchetPath")
    if isinstance(ratchet_declared, str) and ratchet_declared.strip():
        ratchet_path = _resolve(repo_root, ratchet_declared.strip())
        ratchet_relative = _relative(repo_root, ratchet_path)
    else:
        ratchet_path = os.path.join(os.path.dirname(proof_root), DEFAULT_RATCHET_NAME)
        ratchet_relative = _relative(repo_root, ratchet_path)

    measured_roots = proof.get("measuredRoots") or []
    exclusions = proof.get("proofExclusions") or []
    if not isinstance(measured_roots, list) or not isinstance(exclusions, list):
        return None, {
            "code": "pf-config-invalid",
            "exit": 2,
            "config": CONFIG_FILE,
            "message": "`measuredRoots` and `proofExclusions` must be lists when declared",
        }

    measured = [
        {"declared": value, "path": _resolve(repo_root, value),
         "relative": _relative(repo_root, _resolve(repo_root, value))}
        for value in measured_roots if isinstance(value, str) and value.strip()
    ]
    excluded = [
        {"declared": value, "path": _resolve(repo_root, value),
         "relative": _relative(repo_root, _resolve(repo_root, value))}
        for value in exclusions if isinstance(value, str) and value.strip()
    ]
    return {
        "config": cfg.get("path"),
        "repoRoot": repo_root,
        "proofRoot": proof_root,
        "declaredProofRoot": proof_root_declared.strip(),
        "layers": _layers(proof.get("layers")),
        "measuredRoots": measured,
        "proofExclusions": excluded,
        "ratchetPath": ratchet_path,
        "declaredRatchetPath": ratchet_relative,
    }, {}


def resolve_proof_config(root: str) -> tuple[dict | None, dict]:
    """Named alias for callers that make the config-resolution boundary explicit."""
    return load_proof_config(root)
