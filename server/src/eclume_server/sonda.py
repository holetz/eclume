"""Lightweight container healthcheck probe: `python -m eclume_server.sonda fila <name>...`.

Imports only the standard library and the async Redis client (no FastAPI, SQLAlchemy or the
`anthropic` SDK), because it runs every 30 s in every container. Exits 0 if the arq worker of every
named queue renewed its health-check key (16 s), 1 if any is missing and 2 on wrong usage.
"""

from __future__ import annotations

import asyncio
import os
import sys

DEFAULT_REDIS_URL = "redis://127.0.0.1:6379/0"


async def queues_alive(names: list[str]) -> bool:
    """The `eclume:<queue>:health-check` key arq renews every 15 s exists for every queue in `names`."""
    from redis.asyncio import Redis  # noqa: PLC0415 — only when the probe runs

    client = Redis.from_url(os.environ.get("ECLUME_REDIS_URL", DEFAULT_REDIS_URL))
    try:
        return all([bool(await client.exists(f"eclume:{name}:health-check")) for name in names])
    finally:
        await client.aclose()


def main(argv: list[str] | None = None) -> int:
    """`fila <name>...`: 0 if every queue has a live worker, 1 if not."""
    args = sys.argv[1:] if argv is None else argv
    if len(args) < 2 or args[0] != "fila":  # noqa: PLR2004 — `fila` and at least one name
        print("uso: python -m eclume_server.sonda fila <default|agents>...", file=sys.stderr)  # noqa: T201
        return 2
    return 0 if asyncio.run(queues_alive(args[1:])) else 1


if __name__ == "__main__":
    raise SystemExit(main())
