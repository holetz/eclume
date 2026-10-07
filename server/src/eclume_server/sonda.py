"""Sonda leve do healthcheck dos contêineres: `python -m eclume_server.sonda fila <nome>...`.

Importa só a biblioteca padrão e o cliente assíncrono do Redis (nada de FastAPI, SQLAlchemy ou
do SDK `anthropic`), porque roda a cada 30 s em cada contêiner. Sai 0 se o worker arq de cada
fila nomeada renovou a chave de health-check (16 s), 1 se alguma faltar e 2 no uso errado.
"""

from __future__ import annotations

import asyncio
import os
import sys

REDIS_URL_PADRAO = "redis://127.0.0.1:6379/0"


async def filas_vivas(nomes: list[str]) -> bool:
    """A chave `eclume:<fila>:health-check` que o arq renova a cada 15 s existe para toda fila de `nomes`."""
    from redis.asyncio import Redis  # noqa: PLC0415 — só quando a sonda roda

    client = Redis.from_url(os.environ.get("ECLUME_REDIS_URL", REDIS_URL_PADRAO))
    try:
        return all([bool(await client.exists(f"eclume:{nome}:health-check")) for nome in nomes])
    finally:
        await client.aclose()


def main(argv: list[str] | None = None) -> int:
    """`fila <nome>...`: 0 se todas as filas têm o worker vivo, 1 se não."""
    args = sys.argv[1:] if argv is None else argv
    if len(args) < 2 or args[0] != "fila":  # noqa: PLR2004 — `fila` e ao menos um nome
        print("uso: python -m eclume_server.sonda fila <default|agents>...", file=sys.stderr)  # noqa: T201
        return 2
    return 0 if asyncio.run(filas_vivas(args[1:])) else 1


if __name__ == "__main__":
    raise SystemExit(main())
