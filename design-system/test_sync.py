# ruff: noqa: INP001, S101  # loose tests of the script: design-system/ is not a Python package
"""The three `eclume.css` copies match `design-system/styles.css`."""

from __future__ import annotations

import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("ds_sync", Path(__file__).with_name("sync.py"))
assert _spec is not None
assert _spec.loader is not None
ds_sync = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ds_sync)


def test_copies_match_the_source() -> None:
    """No copy diverges: changing the DS is changing the source and running sync.py."""
    assert ds_sync.diverging() == []


def test_generate_drops_google_fonts_and_adds_the_header() -> None:
    """The header is fixed, without a date, and the Google Fonts line goes away."""
    source = "/* top */\r\n@import url('https://fonts.googleapis.com/css2?x');\r\n:root { --a: 1; }\r\n"
    copy = ds_sync.generate(source)
    assert copy == ds_sync.HEADER + "/* top */\n:root { --a: 1; }\n"
    assert ds_sync.generate(source) == copy


def test_check_flags_a_diverging_copy(tmp_path: Path) -> None:
    """A hand-edited copy shows up in `--check`."""
    (tmp_path / "design-system").mkdir()
    (tmp_path / "design-system" / "styles.css").write_text(":root { --a: 1; }\n", encoding="utf-8")
    copies = [tmp_path / c.relative_to(ds_sync.ROOT) for c in ds_sync.COPIES]
    for copy in copies:
        copy.parent.mkdir(parents=True, exist_ok=True)
        copy.write_text(ds_sync.generate(":root { --a: 1; }\n"), encoding="utf-8")
    assert ds_sync.diverging(tmp_path) == []
    copies[1].write_text("edited", encoding="utf-8")
    assert ds_sync.diverging(tmp_path) == [copies[1]]
