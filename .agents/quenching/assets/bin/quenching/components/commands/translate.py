"""Deterministically translate the packaged Claude surface into its Codex sibling."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path

from quenching.common.output import NoAbbrevParser, finding, refuse, report_findings
from quenching.components.surface import generic_surface


SOURCE: Path | None = None
TARGET: Path | None = None
MANIFEST: Path | None = None
COPY_DIRS = ("assets/references", "assets/templates", "assets/specs", "assets/knowledge", "assets/checks", "assets/design", "assets/portal", "assets/bin", "agents")
COPY_FILES = ("bin/cq", "assets/modules.json", "README.md", "VERSION")
DROP_FRONTMATTER = {"argument-hint", "allowed-tools", "model", "context", "hooks"}
FORBIDDEN_AFTER_TRANSLATION = ("${CLAUDE_PLUGIN_ROOT}", "${CLAUDE_PROJECT_DIR}", "CLAUDE_PLUGIN_ROOT")
PLATFORM_NEUTRAL_CLAUDE_CODEX = "\u0043laude or \u0043odex"

CODEX_CQ_WRAPPER = r"""cq() {
  local plugin_root="${CODEX_PLUGIN_ROOT:-${PLUGIN_ROOT:-}}"
  if [ -z "$plugin_root" ]; then
    plugin_root="$(set -o pipefail
codex plugin list --json | python3 -c '
import json, os, sys
from pathlib import Path
plugins = [p for p in json.load(sys.stdin)["installed"] if p.get("name") == "quenching-codex" and p.get("enabled")]
if len(plugins) != 1:
    sys.exit("quenching-codex: enable exactly one installation, or provide its plugin root")
p = plugins[0]
home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
print(p.get("installedPath") or home / "plugins/cache" / p["marketplaceName"] / p["name"] / p["version"])
')" || return 2
  fi
  if [ -z "$plugin_root" ] || [ ! -f "$plugin_root/scripts/cq" ]; then
    echo "quenching-codex: installed plugin root not found; enable the plugin first" >&2
    return 2
  fi
  python3 "$plugin_root/scripts/cq" "$@"
}"""

CQ_INVOCATION = re.compile(r"(?<![A-Za-z0-9_./-])cq(?=\s+(?:--root|--version|--help|specs|knowledge|design|components|git|ops|proof|toolchain|delivery|security|opensource|config|portal|session)\b)")
EXPLICIT_CQ_INVOCATION = re.compile(r"python3\s+(?:\"?\.\./\.\./scripts/cq\"?|\"?scripts/bin/cq\"?)")
RELATIVE_CQ_PATH = re.compile(r"(?<![A-Za-z0-9_./])(?:python3\s+)?\"?\.\./\.\./scripts/cq\"?")


def payload_root() -> Path:
    """The plugin payload — the directory that carries `assets/`.

    This was `Path(__file__).resolve().parents[7]`, naming the marketplace CHECKOUT and reaching
    the payload back down through `plugins/quenching/`. That descent exists only in a development
    clone. An installed plugin unpacks the payload ALONE, under
    `<cache>/<marketplace>/<plugin>/<version>/`, where the same seven hops land two directories
    above it — so `read_adaptation()` died with FileNotFoundError on `codex-adaptation.json` and
    an installed plugin could not translate anything, breaking the promise made in
    `/docs/standards/architecture/surface-translation.md`. Walking UP to the directory that
    actually carries the adaptation map resolves both layouts and asserts nothing about what
    sits above the payload.
    """
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "assets" / "translation" / "codex-adaptation.json").is_file():
            return parent
    raise ValueError("installed plugin does not carry assets/translation/codex-adaptation.json")


def _default_pair(payload: Path, root: str | None) -> tuple[Path, Path]:
    """What a BARE `cq components translate` translates.

    The packaged pair only when the CALLER stands in the marketplace checkout that carries it;
    anywhere else the subject is the caller's own repository surface. Reading the payload alone
    made a target repo's bare probe measure the PLUGIN's translation and report it as the repo's
    — `/quenching-align:components:align` §1 runs exactly this call and read a green it never measured
    — while an installed plugin, having no `plugins/` tree at all, reported every generated file
    as drift. Deciding on the caller's surface root keeps CI's
    `cq --root . components translate --check` on the packaged pair and points every other
    invocation at the repository the caller is actually in.
    """
    codex = payload.parent / "codex" / "quenching-codex"
    surface = Path(root).resolve() if root else None
    if codex.is_dir() and (surface is None or surface.is_relative_to(payload.parent.parent)):
        return payload, codex
    if surface is None:
        raise ValueError("no repository surface to translate; pass --source and --target")
    # `find_surface_root` answers with the `.claude` directory when one exists; both halves of
    # the pair are the repository root, which `claude_surface()`/`codex_surface()` descend from.
    repository = surface.parent if surface.name in (".claude", ".agents") else surface
    return repository, repository


def configure(source: str | None, target: str | None, root: str | None = None) -> None:
    """Resolve the pair once per invocation; callers may translate any checkout pair."""
    global SOURCE, TARGET, MANIFEST
    payload = payload_root()
    # The adaptation is part of the distributed translator, not of a target repository.
    MANIFEST = payload / "assets" / "translation" / "codex-adaptation.json"
    if source or target:
        SOURCE = Path(source).resolve() if source else payload
        TARGET = Path(target).resolve() if target else payload.parent / "codex" / "quenching-codex"
        return
    SOURCE, TARGET = _default_pair(payload, root)


def source() -> Path:
    assert SOURCE is not None
    return SOURCE


def target() -> Path:
    assert TARGET is not None
    return TARGET


def manifest() -> Path:
    assert MANIFEST is not None
    return MANIFEST


def plugin_translation() -> bool:
    """Whether this invocation translates the packaged plugin rather than a repo surface."""
    return (source() / "commands").is_dir()


def claude_surface() -> Path:
    """Resolve a repository root or its `.claude` directory to the Claude surface."""
    return source() if source().name == ".claude" else source() / ".claude"


def codex_surface() -> Path:
    """Resolve a repository root or its `.agents` directory to the Codex surface."""
    return target() if target().name == ".agents" else target() / ".agents"


def generic_target() -> str | None:
    """Why a repository-surface translation must not run here, or None.

    A target that keeps its skills in `.agents/skills/` (or carries the Claude bridge generated
    from them) has `.agents/` as its source; the legacy `.claude` → `.agents` translation would
    write over it.
    """
    if plugin_translation():
        return None
    if generic_surface(str(codex_surface())):
        return f"{codex_surface() / 'skills'} holds the repository's own skills"
    bridge = claude_surface() / "skills" / ".generated-files.json"
    if bridge.is_file():
        return f"{bridge} marks a Claude bridge generated from .agents/skills"
    return None


def read_adaptation() -> dict:
    return json.loads(manifest().read_text(encoding="utf-8"))


# BUILD ARTEFACTS ARE NOT SOURCE, and ONE predicate says so for both readers of the tree.
# The copy below always skipped them; the digest did not, and that asymmetry is the whole bug:
# the generated output was byte-identical on every machine while the digest reported by
# `translate` was not.
# `assets/bin` is a COPY_DIR, so an unfiltered `rglob("*")` walks the `__pycache__/` CPython
# writes the first time anything runs `cq` from the checkout. Those files are gitignored, so a
# machine that has run the tool and a fresh CI clone hash DIFFERENT source sets — and
# the reported digest differs from the one CI computes, though `translate --check` compares only
# generated bytes and stays green. Measured here on
# 2026-08-23: 72 `.pyc` files, one drift finding, and a green local check beside a red CI one.
def _is_build_artefact(path: Path) -> bool:
    return "__pycache__" in path.parts or path.suffix in (".pyc", ".pyo")


def source_files() -> list[Path]:
    if not plugin_translation():
        files = list(sorted((claude_surface() / "commands").rglob("*.md")))
        references = claude_surface() / "references"
        if references.is_dir():
            files.extend(sorted(path for path in references.rglob("*") if path.is_file()))
        harness = claude_surface().parent / "CLAUDE.md"
        if harness.is_file():
            files.append(harness)
        files.append(manifest())
        return files
    files = list(sorted((source() / "commands").rglob("*.md")))
    files.extend(source() / rel for rel in COPY_FILES)
    for rel in COPY_DIRS:
        files.extend(sorted(path for path in (source() / rel).rglob("*") if path.is_file()))
    return [path for path in files if path.is_file() and not _is_build_artefact(path)]


def _portable(path: Path) -> str:
    """The provenance path relative to the working tree, never a machine-absolute path."""
    try:
        return str(path.resolve().relative_to(Path.cwd().resolve()))
    except ValueError:
        return path.name


def source_digest() -> str:
    digest = hashlib.sha256()
    for path in source_files():
        try:
            relative = path.relative_to(source())
        except ValueError:
            relative = path.name
        digest.update(str(relative).encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def module_owners() -> dict[str, str]:
    """Command head -> owning module, from the distribution's own module manifest."""
    data = json.loads((payload_root() / "assets" / "modules.json").read_text(encoding="utf-8"))
    return {rel.removesuffix(".md"): module["name"] for module in data["modules"]
            for rel in module.get("owned", {}).get("commands", [])}


def transform_platform(text: str, adaptation: dict) -> str:
    neutral_marker = "\x00QUENCHING_PLATFORM_NEUTRAL_CLAUDE_CODEX\x00"
    text = text.replace(PLATFORM_NEUTRAL_CLAUDE_CODEX, neutral_marker)
    text = text.replace(".claude/quenching.json", "\x00SHARED_CONFIG\x00")
    text = text.replace("~/.claude/projects/", "\x00SOURCE_MEMORY_ROOT\x00")
    text = text.replace("Claude Code memory", "\x00SOURCE_MEMORY_NAME\x00")
    text = text.replace("Claude Code project memory", "\x00SOURCE_PROJECT_MEMORY_NAME\x00")
    for old, new in adaptation["replacements"].items():
        text = text.replace(old, new)
    owners = module_owners()

    def skill_id(match: re.Match) -> str:
        module, ident = match.group(1), match.group(2)
        if owners.get(ident.split(":", 1)[0]) != module:
            raise ValueError(f"no module owns /{module}:{ident}")
        return "quenching-" + ident.replace(":", "-")

    # Codex ships one plugin, so the module that owns a front leaves the skill id.
    text = re.sub(r"/(quenching-[a-z]+):([A-Za-z0-9:-]+)", skill_id, text)
    text = text.replace("Claude Code", "Codex").replace("Claude", "Codex")
    text = text.replace(neutral_marker, PLATFORM_NEUTRAL_CLAUDE_CODEX)
    text = text.replace("\x00SHARED_CONFIG\x00", ".claude/quenching.json")
    text = text.replace("\x00SOURCE_MEMORY_ROOT\x00", "~/.claude/projects/")
    text = text.replace("\x00SOURCE_MEMORY_NAME\x00", "Claude Code memory")
    text = text.replace("\x00SOURCE_PROJECT_MEMORY_NAME\x00", "Claude Code project memory")
    for marker in FORBIDDEN_AFTER_TRANSLATION:
        if marker in text:
            raise ValueError(f"untranslated platform marker: {marker}")
    return text


def transform_codex_runtime(text: str, adaptation: dict) -> str:
    """Adapt executable Markdown, keeping code examples and source runtime pins intact."""
    models = adaptation["runtime"]["models"]
    # Fenced fixtures and historical snippets are data. Agent YAML frontmatter is active.
    pieces = re.split(r"(```[^\n]*\n[\s\S]*?```)", text)
    for index in range(0, len(pieces), 2):
        pieces[index] = re.sub(r"\b(opus|sonnet|haiku)\b",
                               lambda match: models[match.group()], pieces[index])
        pieces[index] = pieces[index].replace("`TaskStop`", "the host's interrupt-agent tool")
    text = "".join(pieces)
    text = re.sub(r"8\. \*\*Telemetry\.\*\*[\s\S]*?(?=\n## Hard prohibitions)",
        "8. **Telemetry.** Record host-provided usage per Codex model and agent role, never sum "
        "tiers. If the host exposes no token telemetry, report `not measured`; never invoke "
        "Claude transcript/session tools or infer tokens from output length. Audit launched roles "
        "from host agent metadata; state when that audit could not run.\n", text)
    text = text.replace("read with\n`cq components session cost`", "from host-provided Codex telemetry (otherwise `not measured`)")
    text = text.replace("fresh `claude -p`", "fresh Codex host sessions")
    text = text.replace(", Bash(cq components session cost:*)", "")
    text = text.replace("for `claude --agent`", "for the source platform's top-level agent launcher")
    text = text.replace("A worker with no activity for more than **20 min** (its transcript's mtime) and no\n  live child process is stopped with the host's interrupt-agent tool and relaunched **once**.",
        "A worker confirmed inactive for more than **20 min** through host activity/status metadata "
        "and with no active work is interrupted through the host tool and relaunched **once**. "
        "If the host cannot expose activity or active-work evidence, report liveness as unmeasured; "
        "do not infer a stall or restart from silence alone.")
    return text


def codex_runtime_policy(adaptation: dict) -> str:
    models = adaptation["runtime"]["models"]
    return ("## Codex runtime\n\n"
        "Use Codex host sub-agents only. Never launch Claude CLI, request Claude models, or "
        "fall back to Claude during a Codex run. The Claude source may separately delegate "
        "development to Codex. Read each named agent protocol and pass its role, prohibitions, "
        "model and effort to the host's spawn-agent tool; protocol files are not automatically "
        "registered agent types. Use host messaging, completion notifications and interrupt tools "
        "for lifecycle management. If delegation is unavailable, report the limitation; do not "
        "silently replace required independent verification with self-review.\n\n"
        f"Tier mapping: opus → `{models['opus']}`; sonnet → `{models['sonnet']}`; "
        f"haiku → `{models['haiku']}`. Preserve declared effort. Pass model explicitly; "
        "when the host requires a fresh context for model overrides, use that mode and include "
        "the necessary brief and protocol. Use gpt-6-luna for product code only on ONE task "
        "whose `cq specs estimate --task` reports `oracleProtected` and `smallTierEligible` "
        "(an executable `verify:` whose tests sit outside the task's `files:`, nothing under "
        "`/docs/`, projected context at or under 80k); a failed `verify:` returns it to the "
        "session model. Never use gpt-6-luna for judgment roles or for import-memory "
        "classification/executor roles. Report tokens per model and role only "
        "when host telemetry provides them; otherwise `not measured`. Claude session logs and "
        "`cq components session cost` do not measure this Codex run.\n\n")


def has_cq_invocation(text: str) -> bool:
    return bool(CQ_INVOCATION.search(text) or EXPLICIT_CQ_INVOCATION.search(text))


def transform_codex_cq_references(text: str) -> str:
    """Keep generated Codex prose from teaching an unusable relative CLI path."""
    text = RELATIVE_CQ_PATH.sub("cq", text)
    text = text.replace(
        "§Resolving the tool, §Write the resolved path literally on every invocation: bare `cq specs` where\n"
        "the `bin/` shim is on `PATH`, else the plugin path `cq specs`\n"
        "invoked with `python3` or `py` (`allowed-tools: Bash(python3:*), Bash(py:*)`) — **two doors onto one\n"
        "file, and no third rung**.",
        "§Resolving the tool: define the per-call wrapper there, then invoke the bundled `cq specs`\n"
        "function in the same Bash call — **one door onto one file, and no third rung**.",
    )
    text = text.replace(
        "The executable checker is `cq`\n(`cq knowledge validate docs` → exit 0 = conforms). Invoke it by its **literal quoted\n"
        "path** on every call, never through a shell variable holding the interpreter plus the path —",
        "The executable checker is `cq`\n(`cq knowledge validate docs` → exit 0 = conforms). Define the per-call wrapper from\n"
        "the tool-resolution reference, then invoke `cq` in that same Bash call —",
    )
    text = text.replace(
        "Every rung above that fallback is the plugin's own file — bare `cq` through the `bin/` shim on\n"
        "`PATH`, or the plugin path — and nothing else is one. This sentence used to name a rung outside the",
        "The only supported route above that fallback is the plugin's own per-call `cq` wrapper; it resolves\n"
        "the installed plugin copy and nothing else. This sentence used to name a rung outside the",
    )
    return text


def transform_codex_shell_blocks(text: str) -> str:
    """Make every generated shell invocation independent of the user's PATH.

    A Codex Bash call starts a fresh shell, so each cq invocation carries its own
    wrapper resolving the enabled plugin copy instead of relying on state from a
    previous call or on a host-specific PATH mutation.
    """
    lines = text.splitlines()
    output: list[str] = []
    in_bash = False
    block: list[str] = []

    def flush_block() -> None:
        if has_cq_invocation("\n".join(block)):
            body = [EXPLICIT_CQ_INVOCATION.sub("cq", line) for line in block]
            output.extend(CODEX_CQ_WRAPPER.splitlines())
            output.extend(body)
        else:
            output.extend(block)

    for line in lines:
        if re.match(r"^\s*```bash\s*$", line):
            in_bash = True
            block = []
            output.append(line)
        elif in_bash and re.match(r"^\s*```\s*$", line):
            flush_block()
            output.append(line)
            in_bash = False
        elif in_bash:
            block.append(line)
        else:
            output.append(line)
    if in_bash:
        output.extend(block)
    return "\n".join(output) + ("\n" if text.endswith("\n") else "")


def transform_codex_markdown(text: str) -> str:
    """The two prose passes every translated Markdown asset and skill body receives."""
    return transform_codex_shell_blocks(transform_codex_cq_references(text))


def codex_tool_resolution(text: str) -> str:
    """Replace the Claude/host-PATH contract with Codex's per-call resolver."""
    start = text.index("## Resolving the tool")
    resolution = f"""## Resolving the tool

Codex does **not** require `cq` to be installed in the user's PATH.  A bare `cq` in the
examples below means the shell function defined at the start of the same Bash call; never
assume that `cq` is an independently installed command, and never ask the user to add it to
their shell startup files.

```bash
{CODEX_CQ_WRAPPER}
```

The function uses the plugin-provided root when the host exposes one, otherwise it resolves the
single enabled `quenching-codex` copy through `codex plugin list --json` and its exact cache
version. Multiple enabled installations or a missing selected package are refusals; never choose
the first or newest directory in a cache. It then
executes the bundled `scripts/cq` by absolute path.  Defining it again in each Bash call is
intentional: shell state does not survive between calls, and sub-agents may receive a fresh
environment.

There is no target-repository installation step and no third rung: never look for a copy under a
target's `.agents/hooks/`, never install one there, and never modify the user's PATH to make this
tool resolve.

Branch on the **exit code** (0 ok · 1 findings · 2 refusal) and the `--json` payload, never on
prose.

### Write the resolved path literally on every invocation

The wrapper resolves the installed plugin at the point of execution.  Do not copy a relative path
from this reference into a command: a fresh Bash call has no shared working-directory or shell
state to make a plugin-relative path reliable.  Defining the function again in every Bash call is
the portable form, including for sub-agents.

**Chain several writes so a failure stops the run** — `set -e`, or `&&` between them.
"""
    return text[:start] + resolution


def codex_readme(text: str) -> str:
    """Keep the generated README aligned with Codex's actual tool-loading contract."""
    # The plugin-wide hook is Claude Code's hooks/hooks.json; Codex loads none of it.
    text = re.sub(r"^\*\*The one plugin-wide hook\.\*\*[\s\S]*?\n\n", "", text, flags=re.M)
    if "## Install" in text and "## Uninstall or reverse" in text:
        install_start = text.index("## Install")
        uninstall_start = text.index("## Uninstall or reverse", install_start)
        codex_install = """## Install

Install the generated Codex package through its own marketplace catalog,
`.agents/plugins/marketplace.json`. The Claude module catalog is a separate distribution.

```bash
codex plugin marketplace add https://github.com/holetz/quenching.git
codex plugin add quenching-codex@quenching --json
```

Start a new Codex session after installation. Existing sessions may still carry earlier skills.
The official [plugin documentation](https://learn.chatgpt.com/docs/plugins) describes the host flow.
There is no Claude-style `--plugin-dir` command here. The experiment in
`docs/tutorials/first-workflow-study.md` uses the bundled `cq` directly and is the deterministic
path for inspecting the workflow without installing a host integration.

"""
        text = text[:install_start] + codex_install + text[uninstall_start:]
    install_marker = "The CLI has two equivalent entry points:"
    if install_marker in text:
        install = text.index(install_marker)
    else:
        install = text.index("The tool itself is reached through **two doors onto one file**.")
    if "## Uninstall or reverse" in text:
        uninstall = text.index("## Uninstall or reverse")
        text = text[:uninstall] + """## Uninstall or reverse

Remove the Codex package through its host:

```bash
codex plugin remove quenching-codex@quenching --json
```

Repository-owned docs, configuration and commits remain in the target. Reverse an alignment by
reviewing and reverting its commits. Start a new session after changing the installation.

""" + text[install:]
        install = text.index(install_marker) if install_marker in text else text.index(
            "The tool itself is reached through **two doors onto one file**.")
    upgrade = text.index("## Upgrade", install)
    text = (
        text[:install]
        + "The CLI is bundled inside the plugin and is **not** installed in the user's PATH. "
          "Codex skills define a per-call `cq` wrapper that resolves the installed plugin and "
          "executes `scripts/cq` by absolute path; the wrapper is repeated because each Bash call "
          "and each sub-agent may start with a fresh shell. The resolver and its no-global-install "
          "rule live in `references/align/tool-resolution.md`.\n\n"
        + text[upgrade:]
    )
    upgrade = text.index("## Upgrade")
    # The prose under ## Upgrade is replaced. Older source snapshots kept the changelog there;
    # preserve those entries when present, while the current source keeps them in CHANGELOG.md.
    changelog = re.search(r"^- \*\*\d+\.\d+\.\d+:\*\*", text[upgrade:], re.MULTILINE)
    seam = upgrade + changelog.start() if changelog else len(text)
    codex_upgrade = (
        "## Upgrade\n\n"
        "Resolution is **plugin-first, with no user-level install**: every skill resolves the "
        "installed plugin copy at call time, so a version bump reaches consumers when Codex "
        "refreshes the plugin. There is no global `cq` executable to keep in sync."
        "\n\nRefresh the marketplace and install its current package:\n\n"
        "```bash\ncodex plugin marketplace upgrade quenching --json\n"
        "codex plugin add quenching-codex@quenching --json\n"
        "codex plugin list --marketplace quenching --json\n```\n\n"
        "Check the reported `version` and `installedPath`, then start a new session. "
        "Updating Claude modules does not update the Codex package. If migrating from a "
        "mixed installation, disable the old monolith and translated Claude modules in the "
        "Codex plugin browser once `quenching-codex` is installed; duplicate skills can retain "
        "old behavior. Do not repair an installation by editing its cache."
    )
    text = (
        text[:upgrade]
        + codex_upgrade
        + ("\n\n" if changelog else "\n")
        + text[seam:]
    )
    return text


def transform_asset(relative: Path, text: str, adaptation: dict) -> str:
    # This module translates platform markers in its *input*. Its own source is
    # therefore procedure, not payload: translating it would rewrite the markers
    # and paths it must recognize when it runs again from the generated plugin.
    if relative.as_posix() == "quenching/components/commands/translate.py":
        return text
    if relative.as_posix() in {"quenching/session/commands/cost.py",
                               "quenching/session/commands/context.py"}:
        command = relative.stem
        return '\n'.join([
            '"""Generated Codex refusal: source transcript tokens cannot measure this host."""',
            'from quenching.common.output import refuse', '',
            f'def cmd_{command}(args) -> int:',
            '    return refuse({"code": "se-codex-telemetry-unavailable",',
            '                   "message": "Codex token usage not measured: use host telemetry when available; source transcript accounting is unsupported."}, args.json)',
            '',
        ])
    if relative.suffix == ".md":
        text = transform_codex_runtime(text, adaptation)
    text = transform_platform(text, adaptation)
    if relative.as_posix() == "functional-checks.sh":
        return """#!/usr/bin/env bash
# Generated Codex adapter: source stream-json checks require the source host.
# No Claude subprocess is permitted during a Codex run.
set -uo pipefail
case "${1:-}" in
  --selfcheck)
    printf '%s\\n' 'PASS: generated Codex adapter launches no external model runtime'
    exit 0 ;;
  -h|--help)
    printf '%s\\n' 'Codex surface-load measurement unavailable; exit 2 is inconclusive.'
    exit 0 ;;
esac
printf '%s\\n' 'INCONCLUSIVE: no Codex surface-load capture harness is implemented; no model was launched.' >&2
exit 2
"""
    if relative.as_posix() in {"citation-check.sh", "functional-checks.sh"}:
        # The packaged Claude checks and their Codex siblings both live four levels below the
        # repository root, so only the comment naming the levels changes.
        text = text.replace(
            "checks -> assets -> quenching -> plugins -> the repo root",
            "checks -> quenching-codex -> codex -> plugins -> the repo root",
        )
    if relative.as_posix() == "align/tool-resolution.md":
        text = codex_tool_resolution(text)
    if relative.suffix == ".md":
        text = transform_codex_markdown(text)
        if relative.name in {"orchestrator.md", "scout.md", "spec-runner.md", "spec-architect.md", "verifier.md", "git-steward.md", "reviewer.md"}:
            text += "\n" + codex_runtime_policy(adaptation)
    if relative.as_posix() != "quenching/components/surface.py":
        return text
    start = text.index("def discover_commands(")
    end = text.index("\ndef discover_references(", start)
    codex_discovery = '''def discover_commands(commands_dir: str) -> list[dict]:
    """Discover Codex skills as one entry point per ``skills/<name>/SKILL.md``."""
    if not os.path.isdir(commands_dir):
        return []
    out = []
    for dirpath, _dirnames, filenames in os.walk(commands_dir):
        if "SKILL.md" not in filenames:
            continue
        path = os.path.join(dirpath, "SKILL.md")
        name = rel(dirpath, commands_dir)
        text = read_text(path) or ""
        body = body_after_frontmatter(text)
        hooks, hooks_parsed = parse_frontmatter_hooks(text)
        out.append({"command": "/" + name.replace(os.sep, "-"), "path": path,
                    "relpath": name + ".md", "frontmatter": parse_frontmatter(text),
                    "anomalies": frontmatter_anomalies(text), "hooks": hooks,
                    "hooksParsed": hooks_parsed, "body": body,
                    "bodyLines": len(body.splitlines())})
    return sorted(out, key=lambda command: command["command"])
'''
    return text[:start] + codex_discovery + text[end:]


def skill_name(command: Path) -> str:
    commands = source() / "commands" if plugin_translation() else claude_surface() / "commands"
    return "quenching-" + "-".join(command.relative_to(commands).with_suffix("").parts)


def skill_description(description: str) -> str:
    """Keep the source description, including its routing boundary, intact."""
    return description.strip()


def apply_removals(body: str, command_id: str, adaptation: dict) -> str:
    """Cut the spans `removals` declares for this command (a Codex run never nests Codex).

    A marker the source no longer carries is an error: the rule would otherwise go silent.
    """
    for rule in adaptation.get("removals", []):
        if rule["command"] != command_id:
            continue
        start = body.find(rule["from"])
        if start < 0:
            raise ValueError(f"removal marker not found in {command_id}: {rule['from'][:60]!r}")
        stop = start + len(rule["from"])
        if "until" in rule:
            stop = body.find(rule["until"], stop)
            if stop < 0:
                raise ValueError(f"removal end marker not found in {command_id}: {rule['until'][:60]!r}")
        body = body[:start] + rule["replace"] + body[stop:]
    return body


def command_to_skill(command: Path, adaptation: dict, raw: str | None = None) -> str:
    """`raw` translates another version of `command`'s text (`cq components migrate` reads history)."""
    raw = command.read_text(encoding="utf-8") if raw is None else raw
    if not raw.startswith("---\n"):
        raise ValueError(f"command has no frontmatter: {command}")
    end = raw.find("\n---\n", 4)
    if end < 0:
        raise ValueError(f"malformed frontmatter: {command}")
    fields = {"name": skill_name(command), "description": None}
    lines, index = raw[4:end].splitlines(), 0
    while index < len(lines):
        line = lines[index]
        if line.startswith("description:"):
            value = line[len("description:"):].strip()
            if value in {">", ">-", "|", "|-"}:
                index += 1
                pieces = []
                while index < len(lines) and lines[index].startswith((" ", "\t")):
                    pieces.append(lines[index].strip())
                    index += 1
                fields["description"] = " ".join(pieces)
                continue
            fields["description"] = value
        elif ":" in line and line.split(":", 1)[0] not in DROP_FRONTMATTER:
            key, value = line.split(":", 1)
            if key in fields:
                fields[key] = value.strip()
        index += 1
    if not fields["description"]:
        raise ValueError(f"command has no description: {command}")
    origin = ("plugins/quenching/commands/" + str(command.relative_to(source() / "commands"))
              if plugin_translation() else ".claude/commands/" + str(command.relative_to(claude_surface() / "commands")))
    header = ("---\n" + f"name: {fields['name']}\n" +
              f"description: {json.dumps(transform_platform(skill_description(fields['description']), adaptation), ensure_ascii=False)}\n" +
              f"---\n\n<!-- GENERATED FROM {origin} -->\n\n")
    pin = re.search(r"^model: (opus|sonnet|haiku)$", raw[4:end], re.MULTILINE)
    preference = ("Preferred model: `" + adaptation["runtime"]["models"][pin.group(1)] + "`.\n\n") if pin else ""
    effort = re.search(r"^effort: ([a-z]+)$", raw[4:end], re.MULTILINE)
    if command.name == "import-memory.md":
        preference += ("Memory input: existing Claude-format project memory data under `~/.claude/projects/`; "
                       "reading this data does not launch Claude. No Codex memory layout is assumed.\n\n")
    if effort:
        preference += "Declared effort: `" + effort.group(1) + "`.\n\n"
    commands_dir = source() / "commands" if plugin_translation() else claude_surface() / "commands"
    command_id = command.relative_to(commands_dir).with_suffix("").as_posix()
    body = apply_removals(raw[end + len("\n---\n"):], command_id, adaptation)
    return header + "<!-- CODEX RUNTIME START -->\n" + preference + codex_runtime_policy(adaptation) + "<!-- CODEX RUNTIME END -->\n\n" + transform_codex_markdown(transform_platform(
        transform_codex_runtime(body, adaptation), adaptation))


def skill_policy(command: Path, raw: str | None = None) -> bytes | None:
    """Codex's `agents/openai.yaml` that keeps a `disable-model-invocation` command human-only."""
    raw = command.read_text(encoding="utf-8") if raw is None else raw
    end = raw.find("\n---\n", 4) if raw.startswith("---\n") else -1
    flagged = any(line.strip().lower() == "disable-model-invocation: true"
                  for line in raw[4:end].splitlines()) if end > 0 else False
    return b"policy:\n  allow_implicit_invocation: false\n" if flagged else None


def reference_translation(reference: Path, text: str, adaptation: dict) -> str:
    """What a repository's `.claude/references/<rel>` becomes under `.agents/references/<rel>`."""
    if reference.suffix == ".md":
        text = transform_codex_runtime(text, adaptation)
    text = transform_platform(text, adaptation)
    if reference.suffix == ".md":
        text = transform_codex_markdown(text)
    return text


def generated_tree() -> dict[str, bytes]:
    adaptation, output = read_adaptation(), {}
    if not plugin_translation():
        commands = claude_surface() / "commands"
        for command in sorted(commands.rglob("*.md")):
            relative = command.relative_to(commands).with_suffix("")
            output[str(Path("skills") / relative / "SKILL.md")] = command_to_skill(command, adaptation).encode()
            if (policy := skill_policy(command)) is not None:
                output[str(Path("skills") / relative / "agents" / "openai.yaml")] = policy
        references = claude_surface() / "references"
        if references.is_dir():
            for reference in sorted(path for path in references.rglob("*") if path.is_file()):
                relative = reference.relative_to(references)
                translated = reference_translation(reference, reference.read_text(encoding="utf-8"),
                                                   adaptation)
                output[str(Path("references") / relative)] = translated.encode()
        harness = claude_surface().parent / "CLAUDE.md"
        if harness.is_file() and not harness.read_text(encoding="utf-8").lstrip().startswith("@AGENTS.md"):
            # A CLAUDE.md that only imports the root AGENTS.md has nothing to translate: Codex
            # already reads that root file.
            output["AGENTS.md"] = transform_platform(harness.read_text(encoding="utf-8"), adaptation).encode()
        output[".generated-from.json"] = json.dumps({
            "source": _portable(claude_surface()),
            "generator": "cq components translate",
            "command_count": len(list(commands.rglob("*.md"))),
        }, indent=2).encode() + b"\n"
        return output
    version = (source() / "VERSION").read_text(encoding="utf-8").strip()
    output[".codex-plugin/plugin.json"] = json.dumps({
        "name": "quenching-codex", "version": version,
        "description": "Codex translation of the quenching plugin with OKF, provider-owned specs, DTCG design tokens, and deterministic front alignment.",
        "author": {"name": "Israel Holetz", "email": "holetz@gmail.com"}, "license": "MIT",
        "keywords": ["codex", "knowledge-management", "documentation", "spec-driven", "automation"], "skills": "./skills/",
        "interface": {"displayName": "Quenching Codex", "shortDescription": "Deterministic knowledge, design, and spec workflows for Codex",
                      "longDescription": "Generated Codex sibling of the Claude quenching plugin. One DTCG design source projects to interoperable artifacts; Claude remains the source of truth.",
                      "developerName": "Israel Holetz", "category": "Developer Tools", "capabilities": ["Interactive", "Write"],
                      "defaultPrompt": ["Align this repository with quenching.", "Run the quenching knowledge workflow.", "Check the Codex plugin for drift."],
                      "brandColor": "#0F766E", "screenshots": []}}, indent=2, ensure_ascii=False).encode() + b"\n"
    for command in sorted((source() / "commands").rglob("*.md")):
        output[str(Path("skills") / skill_name(command) / "SKILL.md")] = command_to_skill(command, adaptation).encode()
        if (policy := skill_policy(command)) is not None:
            output[str(Path("skills") / skill_name(command) / "agents" / "openai.yaml")] = policy
    for rel in COPY_FILES:
        destination = Path("scripts/cq") if rel == "bin/cq" else Path(rel)
        if rel == "assets/modules.json":
            destination = Path("scripts/modules.json")
        content = transform_platform((source() / rel).read_text(encoding="utf-8"), adaptation)
        if rel == "README.md":
            content = codex_readme(transform_codex_runtime(content, adaptation))
            content = codex_runtime_policy(adaptation) + content
            content = "# quenching-codex (generated)\n\nThis plugin is generated from `plugins/quenching/`, which is the only editable source.\nRun `python3 scripts/sync_codex_plugin.py --write` to refresh it.\n\n" + content
        output[str(destination)] = content.encode()
    for rel in COPY_DIRS:
        source_dir, destination_root = source() / rel, Path(rel.replace("assets/", ""))
        if rel == "assets/bin":
            destination_root = Path("scripts/bin")
        for path in sorted(source_dir.rglob("*")):
            if not path.is_file() or _is_build_artefact(path):
                continue
            relative = path.relative_to(source_dir)
            if relative.name == "CLAUDE.md":
                relative = relative.with_name("AGENTS.md")
            output[str(destination_root / relative)] = transform_asset(relative, path.read_text(encoding="utf-8"), adaptation).encode()
    output[".generated-from.json"] = json.dumps({"source": "plugins/quenching",
        "generator": "cq components translate", "command_count": len(list((source() / "commands").rglob("*.md")))}, indent=2).encode() + b"\n"
    return output


def owned_files() -> set[str]:
    destination = generated_destination()
    actual = {str(path.relative_to(destination)) for path in destination.rglob("*") if path.is_file() and path.name != ".generated-files.json" and "__pycache__" not in path.parts and path.suffix != ".pyc"} if destination.exists() else set()
    if not plugin_translation():
        # A repository's Codex marketplace and other configuration are not generated from
        # `.claude/`. Only the translated harness, skills, and their local references are owned.
        actual = {rel for rel in actual if rel in {"AGENTS.md", ".generated-from.json"}
                  or rel.startswith(("skills/", "references/"))}
    return actual


def differences(tree: dict[str, bytes]) -> list[str]:
    destination = generated_destination()
    actual = owned_files()
    return [rel for rel in sorted(set(tree) | actual) if rel not in tree or not (destination / rel).exists() or (destination / rel).read_bytes() != tree[rel]]


def generated_destination() -> Path:
    """The directory the translation writes: the generated plugin, or the repo's `.agents`."""
    return target() if plugin_translation() else codex_surface()


def reconciliation(tree: dict[str, bytes]) -> str:
    """Classify source and generated-tree changes from the recorded per-file hashes.

    No aggregate source digest is versioned: it changed on every unrelated edit and conflicted
    in every parallel PR. The per-file map in `.generated-files.json` carries the same signal.
    """
    destination = generated_destination()
    generated = destination / ".generated-files.json"
    try:
        hashes = json.loads(generated.read_text(encoding="utf-8")).get("sha256", {})
    except (OSError, ValueError, AttributeError):
        hashes = {}
    if not isinstance(hashes, dict) or not hashes:
        return "untracked"
    target_changed = any(not (destination / rel).is_file()
                         or hashes.get(rel) != hashlib.sha256((destination / rel).read_bytes()).hexdigest()
                         for rel in hashes)
    source_changed = any(hashes.get(rel) != hashlib.sha256(content).hexdigest()
                         for rel, content in tree.items())
    if source_changed:
        return "both-changed" if target_changed else "source-changed"
    return "target-changed" if target_changed else "in-sync"


def _body(text: str) -> str:
    """Return a translated skill's body, excluding generated metadata."""
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end >= 0:
            text = text[end + len("\n---\n"):]
    if text.startswith("\n<!-- GENERATED FROM"):
        marker_end = text.find("-->\n\n")
        if marker_end >= 0:
            text = text[marker_end + len("-->\n\n"):]
    text = re.sub(r"^<!-- CODEX RUNTIME START -->[\s\S]*?<!-- CODEX RUNTIME END -->\n\n", "", text)
    return text


def _claude_body(text: str) -> str:
    models = read_adaptation()["runtime"]["models"]
    for original, translated in models.items():
        text = text.replace(translated, original)
    return (text.replace("${CODEX_PLUGIN_ROOT}", "${CLAUDE_PLUGIN_ROOT}")
                .replace(".agents/", ".claude/")
                .replace("AGENTS.md", "CLAUDE.md")
                .replace("Codex", "Claude"))


def propagate_bodies_from_codex(tree: dict[str, bytes]) -> None:
    """Apply only body edits from a changed Codex tree back to its Claude source.

    Frontmatter and path changes are intentionally refused: the forward map drops information,
    so only the source side can author that structure.
    """
    destination = generated_destination()
    for rel in differences(tree):
        if not rel.startswith("skills/") or not rel.endswith("/SKILL.md") or rel not in tree:
            raise ValueError(f"Codex structural change at {rel}; the Claude side is authoritative")
        if not (destination / rel).is_file():
            raise ValueError(f"Codex structural change at {rel}; the Claude side is authoritative")
        actual = (destination / rel).read_text(encoding="utf-8")
        expected = tree[rel].decode("utf-8")
        actual_header = actual.split("---\n", 2)[:2]
        expected_header = expected.split("---\n", 2)[:2]
        if actual_header != expected_header:
            raise ValueError(f"Codex frontmatter change at {rel}; the Claude side is authoritative")
        prefix_pattern = r"<!-- CODEX RUNTIME START -->[\s\S]*?<!-- CODEX RUNTIME END -->\n\n"
        actual_prefix = re.search(prefix_pattern, actual)
        expected_prefix = re.search(prefix_pattern, expected)
        if (actual_prefix.group() if actual_prefix else None) != (expected_prefix.group() if expected_prefix else None):
            raise ValueError(f"Codex runtime policy change at {rel}; the Claude side is authoritative")
        parts = Path(rel).parts[1:-1]
        source_command = ((source() / "commands") if plugin_translation() else claude_surface() / "commands")
        command = source_command.joinpath(*parts).with_suffix(".md")
        raw = command.read_text(encoding="utf-8")
        header_end = raw.find("\n---\n", 4)
        if header_end < 0:
            raise ValueError(f"Claude command has malformed frontmatter: {command}")
        command.write_text(raw[:header_end + len("\n---\n")] + "\n" + _claude_body(_body(actual)),
                           encoding="utf-8")


def previous_files(manifest: Path, destination: Path) -> set[str] | None:
    """Read the paths a previous run owned, refusing any that would leave the destination.

    The manifest is versioned and mergeable, so every entry is untrusted input: all are checked
    before the caller deletes the first. A manifest that is not JSON at all (merge conflict
    markers) returns None: the caller recovers by regenerating it.
    """
    if not manifest.exists():
        return set()
    try:
        document = json.loads(manifest.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    try:
        files = document["files"]
    except (KeyError, TypeError) as exc:
        raise ValueError(f"{manifest.name} is unreadable or has no `files`: {exc!r}") from exc
    if not isinstance(files, (list, dict)):
        raise ValueError(f"{manifest.name} `files` must be a list or an object")
    contain(files, destination, manifest.name)
    return set(files)


def contain(files, destination: Path, origin: str) -> None:
    """Refuse any path that would resolve outside the destination, before the caller touches one."""
    root = destination.resolve()
    for rel in files:
        if not isinstance(rel, str) or not rel or Path(rel).is_absolute() \
                or not (destination / rel).resolve().is_relative_to(root):
            raise ValueError(f"{origin} names a path outside the destination: {rel!r}")


def manifest_conflicted() -> bool:
    """True when the versioned manifest exists but is not JSON (merge conflict markers)."""
    destination = generated_destination()
    manifest = destination / ".generated-files.json"
    try:
        json.loads(manifest.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return False
    except (ValueError, OSError):
        return True
    return False


def manifest_document(tree: dict[str, bytes]) -> dict:
    return {"files": sorted(tree), "sha256": {rel: hashlib.sha256(content).hexdigest()
                                              for rel, content in sorted(tree.items())}}


def manifest_drifted(tree: dict[str, bytes]) -> bool:
    """True when a readable versioned manifest differs from the one `--write` would produce.

    A missing manifest is `untracked` and an unreadable one is `manifest_conflicted`; neither is drift.
    """
    destination = generated_destination()
    try:
        recorded = json.loads((destination / ".generated-files.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return recorded != manifest_document(tree)


def write_tree(tree: dict[str, bytes]) -> None:
    destination = generated_destination()
    destination.mkdir(parents=True, exist_ok=True)
    generated_manifest = destination / ".generated-files.json"
    previous = previous_files(generated_manifest, destination)
    if previous is None:
        previous = owned_files()
    contain(previous | set(tree), destination, "the destination")
    stale = [destination / rel for rel in sorted(previous - set(tree))]
    for path in stale:
        if path.is_file() or path.is_symlink():
            path.unlink()
    for rel, content in tree.items():
        path = destination / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    generated_manifest.write_text(json.dumps(manifest_document(tree), indent=2) + "\n", encoding="utf-8")


def add_arguments(parser: argparse.ArgumentParser) -> None:
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--diff", action="store_true")
    parser.add_argument("--source", help="Claude surface or plugin source")
    parser.add_argument("--target", help="Codex surface or generated destination")
    parser.add_argument("--json", action="store_true")


def cmd_translate(args, root: str) -> int:
    try:
        configure(args.source, args.target, root)
        reason = generic_target()
        if reason:
            return refuse({"code": "ct-translation-refused",
                           "message": f"{reason}; translating .claude/ into .agents/ would write "
                                      "the legacy translation over the source",
                           "remedy": "keep .agents/ as the source and run "
                                     "`cq components bridge --target <repo> --write` for the "
                                     "Claude copy"}, args.json)
        tree = generated_tree()
    except ValueError as exc:
        return refuse({"code": "ct-translation-refused", "message": str(exc)}, args.json)
    if args.check and not generated_destination().exists():
        # No Codex surface at all is an opted-out repository, not a drifted one: `--write` creates it.
        payload = {"changed": [], "count": 0, "source_sha256": source_digest(), "reconciliation": "absent"}
        return report_findings(args.json, "components translate — no Codex surface to check",
                               payload, [], "path")
    changed, digest = differences(tree), source_digest()
    payload = {"changed": changed, "count": len(changed), "source_sha256": digest,
               "reconciliation": reconciliation(tree)}
    if args.write:
        if reconciliation(tree) == "target-changed":
            try:
                propagate_bodies_from_codex(tree)
            except ValueError as exc:
                return refuse({"code": "ct-reverse-refused", "message": str(exc)}, args.json)
            tree = generated_tree()
        try:
            write_tree(tree)
        except ValueError as exc:
            return refuse({"code": "ct-translation-refused", "message": str(exc)}, args.json)
        payload["changed"] = []
        payload["count"] = 0
    findings = [finding("ct-translation-drift", "error",
                        "generated translation differs from the Claude surface", path=path)
                for path in payload["changed"]]
    if not args.write and manifest_conflicted():
        findings.append(finding("ct-manifest-conflicted", "error",
                                ".generated-files.json is not valid JSON (merge conflict markers?); "
                                "regenerate it with `translate --write`", path=".generated-files.json"))
    if not args.write and manifest_drifted(tree):
        findings.append(finding("ct-manifest-drift", "error",
                                ".generated-files.json differs from the generated set (an entry lost in a merge?); "
                                "regenerate it with `translate --write`", path=".generated-files.json"))
    return report_findings(args.json, f"components translate — {payload['count']} changed file(s)",
                           payload, findings, "path")


def main(argv: list[str] | None = None) -> int:
    parser = NoAbbrevParser(prog="cq components translate")
    add_arguments(parser)
    # The compatibility launcher lives in the marketplace checkout and syncs the packaged pair.
    return cmd_translate(parser.parse_args(argv), str(payload_root().parent.parent))
