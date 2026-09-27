"""Limite de tentativas nas rotas que conferem credencial: janela fixa de 1 minuto no Redis.

Cada rota conta por IP (`attempts`). Os logins por senha também contam por conta
(`count_login`), numa janela comum ao navegador e ao aparelho, e a troca de código de pareamento
tem ainda um teto global (`PAIR_GLOBAL_FACTOR`): trocar de IP não multiplica os chutes.
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
PAIR_GLOBAL_FACTOR = 6


async def count_attempt(ctx: AppContext, key: str, limit: int) -> None:
    """Conta a tentativa em `eclume:rl:<key>` e responde 429 além de `limit` na janela."""
    redis = ctx.queue.pool
    full_key = f"eclume:rl:{key}"
    count = await redis.incr(full_key)
    # NX: a janela começa na primeira tentativa, e uma chave órfã de TTL também ganha o seu.
    await redis.expire(full_key, WINDOW_SECONDS, nx=True)
    if count > limit:
        retry_after = max(await redis.ttl(full_key), 1)
        raise rate_limited("Tentativas demais; espere a janela de um minuto reabrir.", retry_after)


async def count_login(ctx: AppContext, scope: str, email: str) -> None:
    """Janela por conta (`scope` = `user` ou `admin`), comum a todas as rotas de login dela."""
    await count_attempt(ctx, f"{scope}_email:{email.lower()}", ctx.settings.credential_attempts_per_minute)


def attempts(route: str, *, global_factor: int | None = None) -> Callable[[Request, AppContext], Awaitable[None]]:
    """Dependência que conta a tentativa em `eclume:rl:<route>:<ip>` e responde 429 além do limite.

    Com `global_factor`, conta também `eclume:rl:<route>:*`, com teto `global_factor` vezes o por IP.
    """

    async def dependency(request: Request, ctx: Annotated[AppContext, Depends(get_ctx)]) -> None:
        ip = request.client.host if request.client else "desconhecido"
        limit = ctx.settings.credential_attempts_per_minute
        await count_attempt(ctx, f"{route}:{ip}", limit)
        if global_factor is not None:
            await count_attempt(ctx, f"{route}:*", limit * global_factor)

    return dependency
