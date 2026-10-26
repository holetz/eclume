"""eclume GPU worker: consumes `transcribe` from the `eclume:gpu` queue (arq)."""

from importlib.metadata import version

__version__ = version("eclume-worker")
