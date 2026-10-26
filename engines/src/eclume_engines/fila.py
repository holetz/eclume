"""Deprecated alias of `eclume_engines.queue_codec`, kept until the server imports the English names."""

from eclume_engines.queue_codec import deserialize as desserializar
from eclume_engines.queue_codec import serialize as serializar

__all__ = ["desserializar", "serializar"]
