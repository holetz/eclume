"""Limite de tentativas nas rotas que conferem credencial, com contadores no Redis.

Cada rota conta por IP numa janela fixa de 1 minuto (`attempts`). Os logins por senha contam também
as **falhas** por conta (`check_login`, `login_failed`, `login_succeeded`), comuns ao navegador e ao
aparelho: por par (conta, IP), e um teto global da conta que não barra IP que já entrou nela. Assim,
as tentativas de um IP qualquer não trancam a dona da conta. A troca de código de pareamento tem
ainda um teto global (`PAIR_GLOBAL_FACTOR`): trocar de IP não multiplica os chutes. O cadastro tem,
além do teto por minuto, um teto diário de contas criadas por IP (`check_signups`).
O IP vem do uvicorn, que com `--proxy-headers` confia no `X-Forwarded-For` do Caddy.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING, Annotated
from uuid import uuid4

from fastapi import Depends, Request

from eclume_server.context import AppContext, get_ctx
from eclume_server.problems import rate_limited

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

WINDOW_SECONDS = 60
PAIR_GLOBAL_FACTOR = 6
FAILURE_WINDOW_SECONDS = 15 * 60
ACCOUNT_WINDOW_SECONDS = 60 * 60
KNOWN_IP_SECONDS = 30 * 24 * 60 * 60
SIGNUP_WINDOW_SECONDS = 24 * 60 * 60


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


def client_ip(request: Request) -> str:
    """O IP do cliente (com `--proxy-headers`, o que o Caddy repassou)."""
    return request.client.host if request.client else "desconhecido"


def _keys(scope: str, email: str, ip: str) -> tuple[str, str, str]:
    base = f"eclume:rl:{scope}_fail:{email.lower()}"
    return f"{base}:{ip}", base, f"eclume:rl:{scope}_known:{email.lower()}"


async def check_login(ctx: AppContext, scope: str, email: str, ip: str) -> None:
    """429 antes de conferir a senha, se o par (conta, IP) ou a conta passaram do teto de falhas.

    `scope` é `user` (navegador e aparelho) ou `admin`. O teto da conta não vale para IP que entrou
    nela com sucesso nos últimos 30 dias.
    """
    redis = ctx.queue.pool
    pair, account, known = _keys(scope, email, ip)
    if int(await redis.get(pair) or 0) >= ctx.settings.login_failures_per_pair:
        raise rate_limited("Tentativas erradas demais nesta conta; espere a janela reabrir.", await _ttl(ctx, pair))
    if int(await redis.get(account) or 0) >= ctx.settings.login_failures_per_account:
        last_ok = await redis.zscore(known, ip)
        if last_ok is None or last_ok < time.time() - KNOWN_IP_SECONDS:
            raise rate_limited(
                "Tentativas erradas demais nesta conta; espere a janela reabrir.", await _ttl(ctx, account)
            )


async def login_failed(ctx: AppContext, scope: str, email: str, ip: str) -> None:
    """Soma a falha no par (conta, IP), janela de 15 min, e na conta, janela de 1 h."""
    redis = ctx.queue.pool
    pair, account, _ = _keys(scope, email, ip)
    for key, window in ((pair, FAILURE_WINDOW_SECONDS), (account, ACCOUNT_WINDOW_SECONDS)):
        await redis.incr(key)
        await redis.expire(key, window, nx=True)


async def login_succeeded(ctx: AppContext, scope: str, email: str, ip: str) -> None:
    """Zera as falhas do par e guarda o IP como conhecido da conta por 30 dias."""
    redis = ctx.queue.pool
    pair, _, known = _keys(scope, email, ip)
    now = time.time()
    await redis.delete(pair)
    await redis.zadd(known, {ip: now})
    await redis.zremrangebyscore(known, "-inf", now - KNOWN_IP_SECONDS)
    await redis.expire(known, KNOWN_IP_SECONDS)


def _signup_key(ip: str) -> str:
    return f"eclume:rl:signup_day:{ip}"


async def check_signups(ctx: AppContext, ip: str) -> None:
    """429 se o IP já criou o teto diário de contas (janela móvel de 24 h)."""
    redis = ctx.queue.pool
    key = _signup_key(ip)
    now = time.time()
    await redis.zremrangebyscore(key, "-inf", now - SIGNUP_WINDOW_SECONDS)
    if await redis.zcard(key) >= ctx.settings.signups_per_ip_per_day:
        [(_, oldest)] = await redis.zrange(key, 0, 0, withscores=True)
        retry_after = max(int(oldest + SIGNUP_WINDOW_SECONDS - now), 1)
        raise rate_limited("Cadastros demais a partir deste endereço hoje; tente amanhã.", retry_after)


async def signup_created(ctx: AppContext, ip: str) -> None:
    """Conta o cadastro criado no teto diário do IP."""
    redis = ctx.queue.pool
    key = _signup_key(ip)
    await redis.zadd(key, {str(uuid4()): time.time()})
    await redis.expire(key, SIGNUP_WINDOW_SECONDS)


async def _ttl(ctx: AppContext, key: str) -> int:
    return max(await ctx.queue.pool.ttl(key), 1)


def attempts(route: str, *, global_factor: int | None = None) -> Callable[[Request, AppContext], Awaitable[None]]:
    """Dependência que conta a tentativa em `eclume:rl:<route>:<ip>` e responde 429 além do limite.

    Com `global_factor`, conta também `eclume:rl:<route>:*`, com teto `global_factor` vezes o por IP.
    """

    async def dependency(request: Request, ctx: Annotated[AppContext, Depends(get_ctx)]) -> None:
        ip = client_ip(request)
        limit = ctx.settings.credential_attempts_per_minute
        await count_attempt(ctx, f"{route}:{ip}", limit)
        if global_factor is not None:
            await count_attempt(ctx, f"{route}:*", limit * global_factor)

    return dependency
