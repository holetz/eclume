"""Attempt limits on the routes that check a credential, with counters in Redis.

Each route counts per IP in a fixed 1-minute window (`attempts`). Password logins also count
**failures** per account (`check_login`, `login_failed`, `login_succeeded`), shared by the browser and
the device: per (account, IP) pair, plus a global account ceiling that does not block an IP that already
logged into it. So the attempts of an arbitrary IP do not lock out the account owner. The pairing
code exchange also has a global ceiling (`PAIR_GLOBAL_FACTOR`): switching IPs does not multiply the
guesses. Signup has, besides the per-minute ceiling, a daily ceiling of accounts created per IP
(`check_signups`). The two public password-reset routes (check and reset) add their attempts to the
same per-IP key. The IP comes from uvicorn, which with `--proxy-headers` trusts Caddy's `X-Forwarded-For`.
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
    """Count the attempt in `eclume:rl:<key>` and answer 429 beyond `limit` in the window."""
    redis = ctx.queue.pool
    full_key = f"eclume:rl:{key}"
    count = await redis.incr(full_key)
    # NX: the window starts at the first attempt, and a key orphaned of its TTL also gets one.
    await redis.expire(full_key, WINDOW_SECONDS, nx=True)
    if count > limit:
        retry_after = max(await redis.ttl(full_key), 1)
        raise rate_limited("Too many attempts; wait for the one-minute window to reopen.", retry_after)


def client_ip(request: Request) -> str:
    """The client IP (with `--proxy-headers`, the one Caddy passed on)."""
    return request.client.host if request.client else "desconhecido"


def _keys(scope: str, email: str, ip: str) -> tuple[str, str, str]:
    base = f"eclume:rl:{scope}_fail:{email.lower()}"
    return f"{base}:{ip}", base, f"eclume:rl:{scope}_known:{email.lower()}"


async def check_login(ctx: AppContext, scope: str, email: str, ip: str) -> None:
    """429 before checking the password, when the (account, IP) pair or the account exceeded the failure ceiling.

    `scope` is `user` (browser and device) or `admin`. The account ceiling does not apply to an IP that
    logged into it successfully in the last 30 days.
    """
    redis = ctx.queue.pool
    pair, account, known = _keys(scope, email, ip)
    if int(await redis.get(pair) or 0) >= ctx.settings.login_failures_per_pair:
        raise rate_limited(
            "Too many failed attempts on this account; wait for the window to reopen.", await _ttl(ctx, pair)
        )
    if int(await redis.get(account) or 0) >= ctx.settings.login_failures_per_account:
        last_ok = await redis.zscore(known, ip)
        if last_ok is None or last_ok < time.time() - KNOWN_IP_SECONDS:
            raise rate_limited(
                "Too many failed attempts on this account; wait for the window to reopen.", await _ttl(ctx, account)
            )


async def login_failed(ctx: AppContext, scope: str, email: str, ip: str) -> None:
    """Add the failure to the (account, IP) pair, 15 min window, and to the account, 1 h window."""
    redis = ctx.queue.pool
    pair, account, _ = _keys(scope, email, ip)
    for key, window in ((pair, FAILURE_WINDOW_SECONDS), (account, ACCOUNT_WINDOW_SECONDS)):
        await redis.incr(key)
        await redis.expire(key, window, nx=True)


async def login_succeeded(ctx: AppContext, scope: str, email: str, ip: str) -> None:
    """Reset the pair's failures and keep the IP as known to the account for 30 days."""
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
    """429 if the IP already created the daily ceiling of accounts (sliding 24 h window)."""
    redis = ctx.queue.pool
    key = _signup_key(ip)
    now = time.time()
    await redis.zremrangebyscore(key, "-inf", now - SIGNUP_WINDOW_SECONDS)
    if await redis.zcard(key) >= ctx.settings.signups_per_ip_per_day:
        [(_, oldest)] = await redis.zrange(key, 0, 0, withscores=True)
        retry_after = max(int(oldest + SIGNUP_WINDOW_SECONDS - now), 1)
        raise rate_limited("Too many signups from this address today; try tomorrow.", retry_after)


async def signup_created(ctx: AppContext, ip: str) -> None:
    """Count the created signup against the IP's daily ceiling."""
    redis = ctx.queue.pool
    key = _signup_key(ip)
    await redis.zadd(key, {str(uuid4()): time.time()})
    await redis.expire(key, SIGNUP_WINDOW_SECONDS)


async def _ttl(ctx: AppContext, key: str) -> int:
    return max(await ctx.queue.pool.ttl(key), 1)


def attempts(route: str, *, global_factor: int | None = None) -> Callable[[Request, AppContext], Awaitable[None]]:
    """Dependency that counts the attempt in `eclume:rl:<route>:<ip>` and answers 429 beyond the limit.

    With `global_factor`, it also counts `eclume:rl:<route>:*`, with a ceiling `global_factor` times the per-IP one.
    """

    async def dependency(request: Request, ctx: Annotated[AppContext, Depends(get_ctx)]) -> None:
        ip = client_ip(request)
        limit = ctx.settings.credential_attempts_per_minute
        await count_attempt(ctx, f"{route}:{ip}", limit)
        if global_factor is not None:
            await count_attempt(ctx, f"{route}:*", limit * global_factor)

    return dependency
