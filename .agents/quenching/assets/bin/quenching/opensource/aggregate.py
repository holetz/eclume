"""Aggregate the catalog answers of every owner, and the baseline level they reach.

Nothing here probes a control: each owner block is the same ``owner_controls`` the owning front
already embeds. ``present`` stays candidate evidence, never conformance.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from quenching.common.config import load_config
from quenching.controls.evaluate import load_catalog, owner_controls

TEMPLATES = Path(__file__).resolve().parents[3] / "opensource" / "templates"
OWNER = "opensource"
LEVELS = (1, 2, 3)

# Catalog control -> the finding code that names its missing artifact.
CONTROL_CODES = {
    "OSPS-LE-02": "os-license-missing",
    "OSPS-LE-03": "os-license-missing",
    "OSPS-GV-01": "os-governance-missing",
    "OSPS-GV-03": "os-contributing-missing",
    "OSPS-GV-04": "os-governance-missing",
    "COMMUNITY-CONDUCT": "os-conduct-missing",
    "COMMUNITY-PR-TEMPLATE": "os-templates-missing",
    "COMMUNITY-CITATION": "os-citation-missing",
    "COMMUNITY-FUNDING": "os-funding-missing",
    "REUSE-LICENSING": "os-reuse-missing",
}
# Artifacts this front writes that no catalog control names: advisory only.
ARTIFACT_CODES = {
    "support": "os-support-missing",
    "codeowners": "os-codeowners-missing",
    "issue-bug": "os-templates-missing",
    "issue-feature": "os-templates-missing",
}
LANGUAGE = "en"
# README and SECURITY keep their owners: this front reports the hand-off, never writes them.
LANGUAGE_HANDOFFS = (
    {"artifact": "readme", "owner": "knowledge", "command": "/quenching-knowledge align"},
    {"artifact": "security", "owner": "security", "command": "/quenching-security status"},
)
OWNER_COMMANDS = {
    "opensource": "/quenching-opensource align",
    "security": "/quenching-security status",
    "delivery": "/quenching-delivery align",
    "toolchain": "/quenching-toolchain align",
    "knowledge": "/quenching-knowledge align",
    "proof": "/quenching-proof align",
    "git": "/quenching-git branch",
}


def load_sources(directory: Path = TEMPLATES) -> dict[str, Any]:
    return json.loads((directory / "sources.json").read_text(encoding="utf-8"))


def template_integrity(directory: Path = TEMPLATES) -> list[dict[str, Any]]:
    """Every pinned upstream template still hashes to the sha256 recorded when it was fetched."""
    drift = []
    for entry in load_sources(directory)["templates"]:
        if not entry.get("sha256"):
            continue
        path = directory / entry["path"]
        actual = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
        if actual != entry["sha256"]:
            drift.append({"code": "os-template-drift", "severity": "error", "path": entry["path"],
                          "message": f"pinned template differs from {entry.get('url')}"})
    return drift


def applicability(root: str) -> dict[str, Any]:
    signals = sorted(name for name in os.listdir(root)
                     if name.upper().startswith(("LICENSE", "COPYING")))
    installed = (load_config(root, detect_provider_info=False).get("shared", {})
                 .get("profiles", {}) or {}).get("installed") or []
    if OWNER in installed:
        signals.append("shared.profiles.installed")
    return {"state": "applicable" if signals else "not-applicable", "signals": signals}


def _level(blocks: list[dict[str, Any]], optional: set[str]) -> dict[str, Any]:
    levels: dict[str, Any] = {}
    attained = 0
    climbing = True
    for level in LEVELS:
        states: dict[str, list[str]] = {"missing": [], "unknown": []}
        for block in blocks:
            for control in block["controls"]:
                if control["id"] in optional:
                    continue
                for item in control["requirements"]:
                    if item["state"] == "retired" or level not in item["levels"]:
                        continue
                    if item["state"] == "missing":
                        states["missing"].append(item["id"])
                    elif item["state"] in ("not-measured", "refused"):
                        states["unknown"].append(item["id"])
        state = "unmet" if states["missing"] else "unknown" if states["unknown"] else "met"
        levels[str(level)] = {"state": state, "blocking": states["missing"] + states["unknown"]}
        climbing = climbing and state == "met"
        if climbing:
            attained = level
    return {"level": attained, "levels": levels}


def _artifacts(root: str) -> list[dict[str, Any]]:
    rows, seen = [], set()
    for entry in load_sources()["templates"]:
        if entry["artifact"] in seen:
            continue
        seen.add(entry["artifact"])
        rows.append({"artifact": entry["artifact"], "target": entry["target"],
                     "language": entry["language"],
                     "present": os.path.isfile(os.path.join(root, entry["target"]))})
    return rows


def status(root: str) -> dict[str, Any]:
    catalog = load_catalog()
    blocks = [owner_controls(owner, root, catalog) for owner in catalog["owners"]]
    optional = {control["id"] for control in catalog["controls"] if control.get("optional")}
    findings, advisories = [], []
    for control in blocks[catalog["owners"].index(OWNER)]["controls"]:
        missing = [item["id"] for item in control["requirements"] if item["state"] == "missing"]
        if not missing:
            continue
        code = CONTROL_CODES.get(control["id"], f"os-{control['id'].lower()}-missing")
        row = {"code": code, "control": control["id"], "requirements": missing,
               "severity": "info" if control["optional"] else "error"}
        (advisories if control["optional"] else findings).append(row)
    artifacts = _artifacts(root)
    for row in artifacts:
        code = ARTIFACT_CODES.get(row["artifact"])
        if code and not row["present"]:
            advisories.append({"code": code, "artifact": row["artifact"], "severity": "info"})
    return {
        "ok": not findings,
        "root": root,
        "readOnly": True,
        "baseline": {"version": catalog.get("baseline", {}).get("version"), **_level(blocks, optional)},
        "owners": [{**block, "command": OWNER_COMMANDS.get(block["owner"])} for block in blocks],
        "artifacts": artifacts,
        "artifactLanguage": {"language": LANGUAGE, "basis": "template-declaration",
                             "contentVerified": False, "handoffs": list(LANGUAGE_HANDOFFS)},
        "findings": findings,
        "advisories": advisories,
    }


def doctor(root: str) -> dict[str, Any]:
    payload = status(root)
    payload["applicability"] = applicability(root)
    payload["templates"] = template_integrity()
    if payload["applicability"]["state"] == "not-applicable":
        payload["findings"], payload["advisories"] = [], []
    payload["findings"] = payload["templates"] + payload["findings"]
    payload["ok"] = not payload["findings"]
    return payload
