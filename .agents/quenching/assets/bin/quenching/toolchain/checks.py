"""Static finding checks over one toolchain inventory."""
from __future__ import annotations

import re
from pathlib import Path

from quenching.common.front import register_checks
from quenching.toolchain.model import Artifact, Finding, ToolchainInventory


_LOCK_MANIFEST = {
    "uv.lock": "pyproject.toml",
    "poetry.lock": "pyproject.toml",
    "package-lock.json": "package.json",
    "Cargo.lock": "Cargo.toml",
}
_ARBITER_KEYS = {"project.scripts", "tool.coverage", "tool.pytest"}


def _finding(code: str, message: str, path: str) -> Finding:
    band = "Mechanical" if code in {
        "tc-lock-stale", "tc-config-duplicate", "tc-generated-stale"
    } else "Structural"
    return Finding(code, "error", message, path=path, band=band)


def check_lock_stale(inventory: ToolchainInventory) -> list[Finding]:
    manifests = {item.path for item in inventory.manifests}
    return [
        _finding("tc-lock-stale", f"lock `{lock.path}` is missing, invalid or has no matching manifest",
                 lock.path)
        for lock in inventory.locks
        if lock.details.get("parse") != "ok"
        or _LOCK_MANIFEST.get(Path(lock.path).name) not in manifests
    ]


def check_config_duplicate(inventory: ToolchainInventory) -> list[Finding]:
    owners: dict[str, list[str]] = {}
    for artifact in inventory.manifests:
        for key in artifact.details.get("semanticKeys", []):
            owners.setdefault(key, []).append(artifact.path)
    for artifact in inventory.tool_configurations:
        for key in artifact.details.get("keys", []):
            owners.setdefault(str(key), []).append(artifact.path)
    return [
        _finding("tc-config-duplicate", f"configuration key `{key}` is declared in multiple homes",
                 paths[0])
        for key, paths in sorted(owners.items())
        if len(paths) > 1
    ]


def check_generated_stale(inventory: ToolchainInventory) -> list[Finding]:
    findings = []
    for artifact in inventory.manifests:
        declared = artifact.details.get("arbiterDigest")
        expected = artifact.details.get("arbiterDigestExpected")
        if declared and declared != expected:
            findings.append(_finding(
                "tc-generated-stale", "generated configuration arbitration block is stale",
                artifact.path))
    return findings


def _version(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    match = re.search(r"\d+(?:\.\d+)?", value)
    return match.group(0) if match else None


def _runtime(inventory: ToolchainInventory) -> dict[str, list[tuple[str, str]]]:
    values: dict[str, list[tuple[str, str]]] = {}
    for artifact in inventory.manifests:
        details = artifact.details
        if artifact.kind in {"pyproject", "setup-cfg"}:
            value = _version(details.get("requiresPython"))
            if value:
                values.setdefault("python", []).append((artifact.path, value))
        elif artifact.kind == "package-json":
            value = _version(details.get("engines", {}).get("node"))
            if value:
                values.setdefault("node", []).append((artifact.path, value))
        elif artifact.kind == "cargo-toml":
            value = _version(details.get("rustVersion"))
            if value:
                values.setdefault("rust", []).append((artifact.path, value))
    for pin in inventory.language_pins:
        group = "python" if pin.path == ".python-version" else "node"
        value = _version(pin.details.get("value"))
        if value:
            values.setdefault(group, []).append((pin.path, value))
    return values


def check_runtime_drift(inventory: ToolchainInventory) -> list[Finding]:
    findings = []
    for declarations in _runtime(inventory).values():
        versions = {value for _, value in declarations}
        if len(versions) > 1:
            path = declarations[-1][0]
            rendered = ", ".join(f"{source}={value}" for source, value in declarations)
            findings.append(_finding("tc-runtime-drift", f"runtime declarations disagree: {rendered}", path))
    return findings


def _has_lock(inventory: ToolchainInventory, ecosystem: str) -> bool:
    names = {Path(item.path).name for item in inventory.locks}
    return bool(names & ({"uv.lock", "poetry.lock"} if ecosystem == "python"
                         else {"package-lock.json"} if ecosystem == "node"
                         else {"Cargo.lock"}))


def _is_exact_pin(ecosystem: object, spec: str) -> bool:
    if re.fullmatch(r"\s*(?:==|=)\s*\d+(?:\.\d+){1,2}\s*", spec):
        return True
    return ecosystem == "node" and re.fullmatch(r"\s*\d+\.\d+\.\d+\s*", spec) is not None


def check_tool_unpinned(inventory: ToolchainInventory) -> list[Finding]:
    findings = []
    for artifact in inventory.manifests:
        ecosystem = artifact.details.get("ecosystem")
        specs = artifact.details.get("devDependencySpecs", {})
        if not isinstance(specs, dict) or not specs or _has_lock(inventory, ecosystem):
            continue
        unpinned = [name for name, spec in specs.items()
                    if not _is_exact_pin(ecosystem, str(spec))]
        if unpinned:
            findings.append(_finding("tc-tool-unpinned",
                                     f"development tools lack exact pins: {', '.join(sorted(unpinned))}",
                                     artifact.path))
    return findings


def check_build_backend(inventory: ToolchainInventory) -> list[Finding]:
    findings = []
    for artifact in inventory.manifests:
        if artifact.kind != "pyproject" or artifact.details.get("buildBackend"):
            continue
        if artifact.details.get("uvPackage") is False:
            continue
        findings.append(_finding("tc-build-backend-missing",
                                 "buildable pyproject.toml has no build backend", artifact.path))
    return findings


def check_key_unarbitered(inventory: ToolchainInventory) -> list[Finding]:
    findings = []
    for artifact in inventory.manifests:
        semantic = set(artifact.details.get("semanticKeys", []))
        declared = {item.get("key") for item in artifact.details.get("arbiterEntries", [])}
        for key in sorted(semantic & _ARBITER_KEYS - declared):
            findings.append(_finding("tc-key-unarbitered",
                                     f"shared configuration key `{key}` has no arbiter", artifact.path))
    return findings


def run_checks(inventory: ToolchainInventory) -> list[Finding]:
    return CHECK_REGISTRY.run(inventory)


CHECK_REGISTRY = register_checks(
    ("lock-stale", check_lock_stale),
    ("config-duplicate", check_config_duplicate),
    ("generated-stale", check_generated_stale),
    ("runtime-drift", check_runtime_drift),
    ("tool-unpinned", check_tool_unpinned),
    ("build-backend", check_build_backend),
    ("key-unarbitered", check_key_unarbitered),
)
