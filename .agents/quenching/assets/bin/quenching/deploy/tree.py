"""The deterministic target tree `cq deploy` writes.

The tree is built in memory and applied by `cli`; nothing here touches the target.  Generated
files are the vendored payload, one skill per selected command, the Claude bridge and the Claude
agent definitions.  `AGENTS.md` and `.agents/quenching.json` are seeds: created only when absent.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath

from quenching.common.version import VERSION
from quenching.components.commands import bridge
from quenching.deploy import translate

PAYLOAD = ".agents/quenching"
SKILLS = ".agents/skills"
CLAUDE_SKILLS = ".claude/skills"
CLAUDE_AGENTS = ".claude/agents"
OPENCODE_AGENTS = ".opencode/agents"
OPENCODE_CONFIG = "opencode.json"
MODULE_SHORT = {
    "quenching-specs": "specs",
    "quenching-align": "align",
    "quenching-design": "design",
    "quenching-ops": "ops",
    "quenching-proof": "proof",
    "quenching-toolchain": "toolchain",
    "quenching-delivery": "delivery",
    "quenching-security": "security",
    "quenching-opensource": "opensource",
}
FRONT_BY_MODULE = {
    "quenching-specs": ("specs",),
    "quenching-align": ("knowledge", "components"),
    "quenching-design": ("design",),
    "quenching-ops": ("ops",),
    "quenching-proof": ("proof",),
    "quenching-toolchain": ("toolchain",),
    "quenching-delivery": ("delivery",),
    "quenching-security": ("security",),
    "quenching-opensource": ("opensource",),
}
ASSETS_BY_MODULE = {
    "quenching-specs": ("assets/specs", "assets/portal"),
    "quenching-align": ("assets/knowledge", "assets/zensical"),
    "quenching-design": ("assets/design",),
    "quenching-opensource": ("assets/opensource",),
}
MARKDOWN_DIRS = ("assets/references", "assets/templates", "assets/knowledge", "assets/zensical",
                 "assets/design", "assets/opensource", "assets/specs")
IGNORE = {"__pycache__", "tests", "evals", "checks"}
MCP_NAME = "quenching"


class DeployError(ValueError):
    pass


def source_root() -> Path:
    """The installed plugin root that carries `assets/` and `commands/`."""
    return Path(__file__).resolve().parents[4]


def _is_build(path: Path) -> bool:
    return "__pycache__" in path.parts or path.suffix in (".pyc", ".pyo")


def _mode(path: Path) -> int:
    return 0o755 if path.stat().st_mode & 0o111 else 0o644


def _add(tree: dict[str, tuple[bytes, int]], rel: str, data: bytes, mode: int = 0o644) -> None:
    tree[PurePosixPath(rel).as_posix()] = (data, mode)


def _add_tree(tree: dict, source: Path, rel: str, transform=None, exclude=IGNORE) -> None:
    root = source / rel
    if not root.exists():
        return
    paths = [root] if root.is_file() else sorted(root.rglob("*"))
    for path in paths:
        if not path.is_file() or _is_build(path) or any(part in exclude for part in path.parts):
            continue
        relative = path.relative_to(source).as_posix()
        data = path.read_bytes()
        if transform is not None and path.suffix == ".md":
            data = transform(data.decode("utf-8")).encode("utf-8")
        _add(tree, PAYLOAD + "/" + relative, data, _mode(path))


def load_modules(source: Path) -> dict:
    return json.loads((source / "assets" / "modules.json").read_text(encoding="utf-8"))


def normalize_modules(values: list[str] | None, manifest: dict) -> list[str]:
    known = {module["name"] for module in manifest["modules"] if "owned" in module}
    selected: list[str] = []
    for raw in values or ["core"]:
        token = raw.strip()
        if not token:
            continue
        if token == "core":
            token = "specs,align"
        elif token == "all":
            token = ",".join(MODULE_SHORT[name] for name in known)
        for part in token.split(","):
            part = part.strip()
            if not part:
                continue
            name = part if part.startswith("quenching-") else "quenching-" + part
            if name not in known:
                raise DeployError(f"unknown module: {part}")
            if name not in selected:
                selected.append(name)
    if "quenching-specs" not in selected:
        # The one `cq` owner is not optional in a deployed target.
        selected.insert(0, "quenching-specs")
    return selected


def profiles_for(modules: list[str]) -> list[str]:
    fronts: list[str] = []
    for module in modules:
        for front in FRONT_BY_MODULE.get(module, ()):
            if front not in fronts:
                fronts.append(front)
    local = [front for front in ("knowledge", "components", "design", "ops", "proof", "toolchain",
                                 "delivery", "opensource") if front in fronts]
    return (["specs"] if "quenching-specs" in modules else []) + local


def _selected_modules(manifest: dict, modules: list[str]) -> list[dict]:
    return [module for module in manifest["modules"] if module.get("name") in modules]


def _packages(selected: list[dict]) -> list[str]:
    packages: list[str] = []
    for module in selected:
        owned = module.get("owned", {})
        for package in [*owned.get("packages", []),
                        *module.get("generatedSupport", {}).get("packages", [])]:
            if package not in packages:
                packages.append(package)
    return packages


def _commands(source: Path) -> dict[str, Path]:
    root = source / "commands"
    return {path.relative_to(root).as_posix(): path
            for path in sorted(root.rglob("*.md")) if path.is_file()}


def _agents(source: Path) -> dict[str, Path]:
    return {path.stem: path for path in sorted((source / "agents").glob("*.md"))}


def _agents_md(target: Path) -> str:
    docs = target / "docs" / "index.md"
    knowledge = ("- Durable knowledge: [`docs/index.md`](docs/index.md).\n" if docs.is_file()
                 else "- Durable knowledge: run `/quenching-knowledge-align` to install the "
                      "`/docs/` bundle.\n")
    return (
        "# AGENTS.md\n\n"
        "This repository uses quenching. The editable automation surface is `.agents/`; the\n"
        "Claude Code bridge under `.claude/skills/` is generated from it.\n\n"
        "- Configuration: [`.agents/quenching.json`](.agents/quenching.json).\n"
        + knowledge +
        "- Skills: `.agents/skills/` (source) and `.claude/skills/` (generated bridge).\n"
        "- Deployed runtime: `.agents/quenching/` (generated; do not edit).\n"
        "- Upgrade with `cq deploy --write` from a new quenching release; never edit a generated "
        "file.\n"
    )


def _seed_config(target: Path, profiles: list[str]) -> str:
    from quenching.config.seed import seed_document
    document = seed_document(str(target))
    # Deploy installs the surface; it does not choose a specs backend. The target's own
    # `/quenching-knowledge-align` (or `cq doctor --setup`) records that decision.
    document.pop("backend", None)
    shared = document.setdefault("shared", {})
    shared["profiles"] = {"installed": profiles}
    return json.dumps(document, indent=2, ensure_ascii=False) + "\n"


def _uvx_shim(version: str) -> tuple[bytes, bytes]:
    source = f"git+https://github.com/holetz/quenching@{version}#subdirectory=plugins/quenching"
    sh = ("#!/usr/bin/env sh\n"
          f"exec uvx --from \"{source}\" cq \"$@\"\n")
    cmd = ("@echo off\r\n"
           f"uvx --from \"{source}\" cq %*\r\n")
    return sh.encode(), cmd.encode()


def _bridge_tree(tree: dict, target: Path) -> None:
    """Every skill gets the marked Claude copy: generated ones and the target's own."""
    skill_files = {rel: (data, mode) for rel, (data, mode) in tree.items()
                   if rel.startswith(SKILLS + "/") and rel.endswith("/SKILL.md")}
    for rel, (data, mode) in sorted(skill_files.items()):
        name = rel[len(SKILLS) + 1:].split("/", 1)[0]
        text = bridge.with_marker(data.decode("utf-8"), name)
        destination = CLAUDE_SKILLS + rel[len(SKILLS):]
        _add(tree, destination, text.encode("utf-8"), mode)

    # A target may already carry its own skills. They are not deploy-owned source, but the
    # bridge is a byte copy of every skill; generating it here keeps the contract coherent.
    source = target / ".agents" / "skills"
    generated = {rel[len(SKILLS) + 1:].split("/", 1)[0] for rel in skill_files}
    if source.is_dir():
        for folder in sorted(source.iterdir()):
            if not folder.is_dir() or folder.name in generated:
                continue
            for path in sorted(folder.rglob("*")):
                if not path.is_file():
                    continue
                relative = path.relative_to(source).as_posix()
                data = path.read_bytes()
                if path.name == bridge.SKILL_FILE and path.parent == folder:
                    data = bridge.with_marker(data.decode("utf-8"), folder.name).encode("utf-8")
                _add(tree, CLAUDE_SKILLS + "/" + relative, data, _mode(path))

    manifest: dict[str, str] = {}
    prefix = CLAUDE_SKILLS + "/"
    for rel, (data, _mode_) in sorted(tree.items()):
        if rel.startswith(prefix) and rel != CLAUDE_SKILLS + "/.generated-files.json":
            manifest[rel[len(prefix):]] = hashlib.sha256(data).hexdigest()
    if manifest:
        document = {
            "generator": "cq deploy (cq components bridge marker)",
            "source": SKILLS,
            "verifiedClaudeCode": bridge.VERIFIED_CLAUDE_CODE,
            "files": manifest,
        }
        _add(tree, CLAUDE_SKILLS + "/.generated-files.json",
             (json.dumps(document, indent=2) + "\n").encode(), 0o644)


def _mcp_argv(mcp: dict) -> list[str]:
    """The declared Python prefix, the vendored entry point and the mounted pillar's `mcp`."""
    return [*mcp["command"], PAYLOAD + "/assets/bin/cq", *mcp["mount"].split(), "mcp"]


def _toml_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _mcp_tree(tree: dict, mcp: dict, harnesses: list[str]) -> None:
    """One whole file per harness that reads a project MCP server. The file belongs to the
    target and to the deploy manifest: a hand edit is drift, not a second owner."""
    argv = _mcp_argv(mcp)
    if "claude" in harnesses:
        document = {"mcpServers": {MCP_NAME: {"command": argv[0], "args": argv[1:]}}}
        _add(tree, ".mcp.json",
             (json.dumps(document, indent=2, ensure_ascii=False) + "\n").encode())
    if "codex" in harnesses:
        lines = [f"[mcp_servers.{MCP_NAME}]",
                 f"command = {_toml_string(argv[0])}",
                 "args = [" + ", ".join(_toml_string(part) for part in argv[1:]) + "]"]
        _add(tree, ".codex/config.toml", ("\n".join(lines) + "\n").encode())
    if "opencode" in harnesses:
        document = {"$schema": "https://opencode.ai/config.json",
                    "mcp": {MCP_NAME: {"type": "local", "command": argv, "enabled": True}}}
        _add(tree, OPENCODE_CONFIG,
             (json.dumps(document, indent=2, ensure_ascii=False) + "\n").encode())


def build_tree(source: Path, target: Path, modules: list[str], harnesses: list[str],
               runtime: str = "vendor", profiles: list[str] | None = None,
               mcp: dict | None = None) -> dict:
    manifest = load_modules(source)
    selected = _selected_modules(manifest, modules)
    if not selected:
        raise DeployError("no module selected")
    packages = _packages(selected)
    missing = [package for package in packages
               if not (source / "assets" / "bin" / "quenching" / package).is_dir()]
    if missing:
        raise DeployError("source does not carry the selected module packages: "
                          + ", ".join(sorted(missing)))
    tree: dict[str, tuple[bytes, int]] = {}

    # Payload: the runtime and the shared procedure the conductor reads.
    if runtime == "vendor":
        for package in packages:
            _add_tree(tree, source, "assets/bin/quenching/" + package)
        _add_tree(tree, source, "assets/bin/quenching_launch.py")
        _add_tree(tree, source, "assets/bin/cq")
        _add_tree(tree, source, "bin/cq")
        _add_tree(tree, source, "bin/cq.cmd")
    _add_tree(tree, source, "assets/modules.json")
    _add_tree(tree, source, "VERSION")
    _add_tree(tree, source, ".claude-plugin/plugin.json")
    _add_tree(tree, source, "assets/references", translate.reference_document)
    _add_tree(tree, source, "assets/templates", translate.reference_document)
    _add_tree(tree, source, "assets/translation")
    for module in selected:
        for rel in ASSETS_BY_MODULE.get(module["name"], ()):
            _add_tree(tree, source, rel, translate.reference_document)

    # Every command body stays in the payload for the root conductor; only selected commands
    # become skills.
    for rel, path in _commands(source).items():
        _add(tree, f"{PAYLOAD}/commands/{rel}",
             translate.command_document(path.read_text(encoding="utf-8")).encode(), _mode(path))
    for name, path in _agents(source).items():
        _add(tree, f"{PAYLOAD}/agents/{name}.md",
             translate.agent_document(path.read_text(encoding="utf-8"), name).encode(), _mode(path))

    if runtime == "uvx":
        sh, cmd = _uvx_shim(VERSION)
        _add(tree, PAYLOAD + "/bin/cq", sh, 0o755)
        _add(tree, PAYLOAD + "/bin/cq.cmd", cmd, 0o644)
    if mcp:
        _mcp_tree(tree, mcp, harnesses)

    # Skills are generated only from the selected modules' commands.
    selected_commands: list[str] = []
    for module in selected:
        for rel in module["owned"]["commands"]:
            base = source / "commands" / rel
            paths = [base] if base.is_file() else sorted(base.rglob("*.md"))
            for path in paths:
                if path.is_file():
                    relative = path.relative_to(source / "commands").as_posix()
                    if relative not in selected_commands:
                        selected_commands.append(relative)
    skill_names: list[str] = []
    for rel in sorted(selected_commands):
        raw = (source / "commands" / rel).read_text(encoding="utf-8")
        name = translate.skill_name(rel)
        skill_names.append(name)
        _add(tree, f"{SKILLS}/{name}/SKILL.md", translate.skill_document(raw, rel).encode(), 0o644)

    if "claude" in harnesses:
        _bridge_tree(tree, target)
        for name, path in _agents(source).items():
            _add(tree, f"{CLAUDE_AGENTS}/{translate.agent_name(name)}.md",
                 translate.agent_document(path.read_text(encoding="utf-8"), name).encode(), 0o644)
    if "opencode" in harnesses:
        # OpenCode reads `.opencode/agents/`, not `.claude/agents/`; a target without the
        # marketplace plugin would otherwise keep every skill and lose the operator agents.
        for name, path in _agents(source).items():
            _add(tree, f"{OPENCODE_AGENTS}/{translate.agent_name(name)}.md",
                 translate.opencode_agent_document(path.read_text(encoding="utf-8"), name).encode(),
                 0o644)

    seeds = {
        "AGENTS.md": _agents_md(target),
        ".agents/quenching.json": _seed_config(target, profiles or profiles_for(modules)),
    }
    document = {
        "generator": "cq deploy",
        "version": VERSION,
        "source": "plugins/quenching",
        "modules": modules,
        "profiles": profiles or profiles_for(modules),
        "harnesses": harnesses,
        "runtime": runtime,
        "skills": sorted(skill_names),
        "files": {rel: hashlib.sha256(data).hexdigest() for rel, (data, _mode_) in sorted(tree.items())},
    }
    if mcp:
        document["mcp"] = mcp
    return {"tree": tree, "seeds": seeds, "manifest": document}
