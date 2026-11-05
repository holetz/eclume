"""Render the proof root's generated layer README without replacing authored prose."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from quenching.proof.model import ProofInventory


README_START = "<!-- quenching-proof-readme-start -->"
README_END = "<!-- quenching-proof-readme-end -->"
README_HASH = "quenching-proof-readme-sha256"
_README_ZONE = re.compile(rf"{re.escape(README_START)}.*?{re.escape(README_END)}", re.DOTALL)


def _layers_payload(inventory: ProofInventory) -> list[dict[str, Any]]:
    """Serialize the declarations and derived counts that make the README true."""
    result = []
    for layer in inventory.layers:
        tests = [item for item in inventory.test_modules if item.layer == layer.name]
        fixtures = [item for item in inventory.fixtures if item.library]
        result.append({
            "name": layer.name,
            "reach": layer.reach or "not declared",
            "budget": layer.budget,
            "required": layer.required,
            "marker": layer.name,
            "tests": len(tests),
            "testPaths": [item.path for item in tests],
            "fixtures": sorted({item.path for item in fixtures}),
        })
    return result


def readme_digest(inventory: ProofInventory) -> str:
    """Return the stable digest for the generated layer data."""
    canonical = json.dumps(_layers_payload(inventory), ensure_ascii=False,
                           sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def render_readme_block(inventory: ProofInventory) -> str:
    """Render the complete generated README zone for one inventory."""
    lines = [
        README_START,
        f"<!-- {README_HASH} {readme_digest(inventory)} -->",
        "## Declared proof layers",
    ]
    layers = _layers_payload(inventory)
    if not layers:
        lines.append("No proof layers are declared; the target owner must choose a layer taxonomy.")
    for layer in layers:
        lines.extend([
            "",
            f"### {layer['name']}",
            f"- Proves: the `{layer['name']}` proof contract declared by the target.",
            f"- Marker: `{layer['marker']}`",
            f"- Reach: {layer['reach']}",
            f"- Budget: {layer['budget'] if layer['budget'] is not None else 'not declared'}",
            f"- Required: {'yes' if layer['required'] else 'no'}",
            f"- Test modules: {layer['tests']}",
            f"- Fixture modules: {', '.join(f'`{path}`' for path in layer['fixtures']) or 'none'}",
        ])
    lines.append(README_END)
    return "\n".join(lines)


def render_readme_document(document: str, inventory: ProofInventory) -> str:
    """Replace the generated zone, preserving every byte outside it."""
    block = render_readme_block(inventory)
    matches = list(_README_ZONE.finditer(document))
    if len(matches) > 1:
        raise ValueError("proof README has more than one generated zone")
    if matches:
        match = matches[0]
        return document[:match.start()] + block + document[match.end():]
    if not document:
        return block + "\n"
    return document.rstrip("\n") + "\n\n" + block + "\n"


def readme_path(inventory: ProofInventory) -> Path:
    return Path(inventory.proof_root) / "README.md"


def write_readme(inventory: ProofInventory) -> bool:
    """Write the generated zone and return whether the document changed."""
    path = readme_path(inventory)
    try:
        document = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        document = ""
    updated = render_readme_document(document, inventory)
    if updated == document:
        return False
    path.write_text(updated, encoding="utf-8")
    return True
