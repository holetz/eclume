"""`quenching://references/` — the plugin's `assets/references/**` served as MCP resources.

The same reading rule as `cq components read`: a reference fits whole only under `DOC_WHOLE`;
above it the answer is its outline, and `?section=<heading>` (repeatable) returns just those
sections. A URI resolves only to a `.md` file really inside `assets/references/`.
"""
from __future__ import annotations

import os
import re
from urllib.parse import parse_qs, urlsplit

try:
    from quenching.components.sections import markdown_sections, select_sections
except ImportError:  # a module without `components` carries the specs copy of the same rule
    from quenching.specs.mcp import markdown_sections, select_sections
from quenching.mcp.server import BAD_PARAMS, MAX_CHARS, NOT_FOUND, ResourceError, dump

REFERENCES = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.realpath(__file__))))), "references")
DOC_WHOLE = 24_000
INDEX_URI = "quenching://references"
# Split so the citation checker reads the plugin-relative parent, not a file this package omits.
_PLUGIN_REFERENCES = "${CLAUDE_PLUGIN_ROOT}/assets/" + "references/"
PATH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]*\.md$")


def _inside(path: str) -> bool:
    return os.path.realpath(path).startswith(os.path.realpath(REFERENCES) + os.sep)


def files() -> list[str]:
    """Every `.md` under `assets/references/`, relative, `/`-separated, sorted."""
    found = []
    for folder, dirs, names in os.walk(REFERENCES, followlinks=False):
        dirs.sort()
        for name in sorted(names):
            full = os.path.join(folder, name)
            if name.endswith(".md") and _inside(full) and os.path.isfile(full):
                found.append(os.path.relpath(full, REFERENCES).replace(os.sep, "/"))
    return found


def _read(rel: str) -> str:
    with open(os.path.join(REFERENCES, *rel.split("/")), encoding="utf-8",
              errors="replace") as handle:
        text = handle.read()
    # A reference is read through the MCP surface, where its sibling citations resolve as
    # resources too: the plugin-root link is a checkout path the server does not serve.
    return text.replace(_PLUGIN_REFERENCES, INDEX_URI + "/")


def _title(heads: list[dict], rel: str) -> str:
    return next((h["heading"] for h in heads if h["level"] == 1), rel)


def _outline(heads: list[dict]) -> list[dict]:
    return [{"level": h["level"], "heading": h["heading"], "chars": len(h["body"])}
            for h in heads]


def _cut(text: str, mime: str, hint: str) -> tuple[str, str]:
    if len(text) <= MAX_CHARS:
        return mime, text
    return "application/json", dump({"ok": True, "truncated": True, "chars": len(text),
                                     "kept": MAX_CHARS, "hint": hint, "text": text[:MAX_CHARS]})


def _index() -> tuple[str, str]:
    rows = []
    for rel in files():
        text = _read(rel)
        rows.append({"uri": f"{INDEX_URI}/{rel}", "title": _title(markdown_sections(text), rel),
                     "chars": len(text)})
    return _cut(dump({"ok": True, "count": len(rows), "references": rows}), "application/json",
                "read one reference instead")


def _reference(rel: str, query: dict) -> list[tuple[str, str]]:
    if not PATH.match(rel) or any(p in ("", ".", "..") for p in rel.split("/")):
        raise ResourceError(BAD_PARAMS, "not a reference path")
    full = os.path.join(REFERENCES, *rel.split("/"))
    if not _inside(full) or not os.path.isfile(full):
        raise ResourceError(NOT_FOUND, f"no such reference: {rel}")
    text = _read(rel)
    heads = markdown_sections(text)
    wanted = query.get("section")
    if wanted:
        got, missing = select_sections(heads, wanted)
        if missing:
            raise ResourceError(BAD_PARAMS, "no such section: " + "; ".join(missing)
                                + " — read the reference without `section` for its outline")
        merged = "\n\n".join(f"{'#' * h['level']} {h['heading']}\n\n{h['body']}".rstrip()
                             for h in got)
        return [_cut(merged, "text/markdown", "ask for fewer sections")]
    outline = {"ok": True, "title": _title(heads, rel), "chars": len(text),
               "outline": _outline(heads)}
    if len(text) <= DOC_WHOLE:
        return [("text/markdown", text), ("application/json", dump(outline))]
    outline.update(truncated=True,
                   hint="above the document ceiling: ask `?section=<heading>` for one section")
    return [_cut(dump(outline), "application/json", "ask for one section")]


def list_resources(root: str) -> list[dict]:
    items = [{"uri": INDEX_URI, "name": "references", "title": "Plugin references index",
              "description": "Every reference under assets/references with its size.",
              "mimeType": "application/json"}]
    for rel in files():
        items.append({"uri": f"{INDEX_URI}/{rel}", "name": rel,
                      "title": _title(markdown_sections(_read(rel)), rel),
                      "mimeType": "text/markdown"})
    return items


def resource_templates() -> list[dict]:
    return [{"uriTemplate": INDEX_URI + "/{path}{?section}", "name": "reference",
             "title": "A plugin reference, whole when small, else by section",
             "mimeType": "text/markdown"}]


def read_resource(uri, root: str) -> list[dict]:
    """The `contents` of one `resources/read` under `quenching://references`. Raises
    `ResourceError` — `NOT_FOUND` for any other uri, so a composite can pass it on."""
    if not isinstance(uri, str) or len(uri) > 500:
        raise ResourceError(BAD_PARAMS, "`uri` must be a string")
    try:
        parts = urlsplit(uri)
        query = parse_qs(parts.query, keep_blank_values=True, strict_parsing=bool(parts.query))
    except ValueError:
        raise ResourceError(BAD_PARAMS, "malformed uri") from None
    if parts.scheme != "quenching" or parts.netloc != "references":
        raise ResourceError(NOT_FOUND, f"unknown resource: {uri}")
    rest = parts.path.lstrip("/")
    if set(query) - {"section"} or (not rest and query):
        raise ResourceError(BAD_PARAMS, "`references` takes only `section`, on one reference")
    pairs = _reference(rest, query) if rest else [_index()]
    return [{"uri": uri, "mimeType": mime, "text": text} for mime, text in pairs]


class ReferencesSurface:
    """The references as a surface of the common core: resources only, no tools."""

    name = "quenching"

    @staticmethod
    def has_tool(name: str) -> bool:
        return False

    @staticmethod
    def list_tools() -> list[dict]:
        return []

    @staticmethod
    def call_tool(name, args, root, session):
        raise KeyError(name)

    @staticmethod
    def list_resources(root):
        return list_resources(root)

    @staticmethod
    def resource_templates():
        return resource_templates()

    @staticmethod
    def read_resource(uri, root):
        return read_resource(uri, root)
