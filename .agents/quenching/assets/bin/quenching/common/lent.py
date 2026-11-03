"""Capabilities one pillar lends another, so the borrower never imports the lender.

`cq` lends, at dispatch, what an enabled module carries; a copy without `cq` or without the
lender's package (the `quenching-specs-reader`) lends nothing, and the borrower refuses on its own.
Only a module path is registered: the lender is imported when borrowed, never before.
"""
from __future__ import annotations

import importlib
from types import ModuleType

_LENT: dict[str, str] = {}


def lend(name: str, module: str) -> None:
    _LENT[name] = module


def borrow(name: str) -> ModuleType | None:
    module = _LENT.get(name)
    return importlib.import_module(module) if module else None
