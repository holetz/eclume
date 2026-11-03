"""Console scripts for the packaged plugin, preserving its asset-relative layout."""
from pathlib import Path
import runpy
import sys


def _router():
    # The build maps this file to quenching_plugin/launch.py.
    bin_path = Path(__file__).resolve().parent / "assets" / "bin"
    sys.path.insert(0, str(bin_path))
    return runpy.run_path(str(bin_path / "cq"))["main"]


def cq() -> int:
    return _router()(sys.argv[1:])


def mcp() -> int:
    return _router()(["mcp", *sys.argv[1:]])
