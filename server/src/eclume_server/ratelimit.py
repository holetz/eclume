"""Limite de tentativas por IP nas rotas que conferem credencial: janela fixa de 1 minuto no Redis.

O IP vem do uvicorn, que com `--proxy-headers` confia no `X-Forwarded-For` do Caddy.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated

from fastapi import Depends, Request

from eclume_server.context import AppContext, get_ctx
from eclume_server.problems import rate_limited

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

WINDOW_SECONDS = 60


def attempts(route: str) -> Callable[[Request, AppContext], Awaitable[None]]:
    """Dependência que conta a tentativa em `eclume:rl:<route>:<ip>` e responde 429 além do limite."""

    async def dependency(request: Request, ctx: Annotated[AppContext, Depends(get_ctx)]) -> None:
        ip = request.client.host if request.client else "desconhecido"
        key = f"eclume:rl:{route}:{ip}"
        redis = ctx.queue.pool
        count = await redis.incr(key)
        # NX: a janela começa na primeira tentativa, e uma chave órfã de TTL também ganha o seu.
        await redis.expire(key, WINDOW_SECONDS, nx=True)
        if count > ctx.settings.credential_attempts_per_minute:
            retry_after = max(await redis.ttl(key), 1)
            raise rate_limited("Tentativas demais; espere a janela de um minuto reabrir.", retry_after)

    return dependency
