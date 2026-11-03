# ruff: noqa: INP001  # standalone script: design-system/ is not a Python package
"""Generates the three Design System copies from `design-system/styles.css`.

Writes `web/src/styles/eclume.css`, `desktop/ui/eclume.css` and `mobile/ui/src/styles/eclume.css` with
a fixed header and without the Google Fonts `@import` line (the fonts come from each client's
`fonts.css`). No date in the header: the output is deterministic. With `--check`, it only compares
and fails when a copy diverges from the source.

Usage: `uv run python design-system/sync.py [--check]`
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "design-system" / "styles.css"
COPIES = (
    ROOT / "web" / "src" / "styles" / "eclume.css",
    ROOT / "desktop" / "ui" / "eclume.css",
    ROOT / "mobile" / "ui" / "src" / "styles" / "eclume.css",
)
HEADER = (
    "/* Generated from design-system/styles.css by design-system/sync.py, without the Google Fonts @import.\n"
    "   Do not edit: product adjustments go in app.css. */\n"
)


def generate(source: str) -> str:
    """The content of a copy: the header and the source without the Google Fonts line, in LF."""
    lines = source.replace("\r\n", "\n").splitlines(keepends=True)
    return HEADER + "".join(line for line in lines if "fonts.googleapis.com" not in line)


def diverging(root: Path = ROOT) -> list[Path]:
    """The copies that do not match the source."""
    expected = generate((root / SOURCE.relative_to(ROOT)).read_text(encoding="utf-8"))
    copies = [root / c.relative_to(ROOT) for c in COPIES]
    return [c for c in copies if not c.exists() or c.read_bytes().decode("utf-8").replace("\r\n", "\n") != expected]


def main(argv: list[str] | None = None) -> int:
    """Writes the copies, or only checks them with `--check`."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="only compares; fails if a copy diverges")
    args = parser.parse_args(argv)
    if args.check:
        stale = diverging()
        for copy in stale:
            print(f"diverges from the source: {copy.relative_to(ROOT)}", file=sys.stderr)  # noqa: T201
        if stale:
            print("run: uv run python design-system/sync.py", file=sys.stderr)  # noqa: T201
        return 1 if stale else 0
    content = generate(SOURCE.read_text(encoding="utf-8"))
    for copy in COPIES:
        copy.write_bytes(content.encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
