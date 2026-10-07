"""Cotas por conta: a cota efetiva (sobreposição da conta sobre o padrão), o uso e as checagens.

As cotas padrão vivem em `platform_settings.quotas`; `users.quotas` guarda só os campos que a conta
sobrepõe. `null` é "sem limite". Os minutos de GPU e os pedidos ao agente contam numa janela móvel
de 24 h: os minutos pela duração das gravações despachadas (`transcription_jobs.dispatched_at`), os
pedidos num conjunto ordenado por conta no Redis (`eclume:quota:agent:{owner}`), aparado a cada
leitura. Contrato em docs/standards/code/server-nucleo.md (§Upload e áudio) e server-agentes.md.
"""

from __future__ import annotations

import logging
import math
import time
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from sqlalchemy import func, select

from eclume_server.db import tables as t
from eclume_server.problems import ApiProblemError, rate_limited

if TYPE_CHECKING:
    from collections.abc import AsyncIterator
    from uuid import UUID

    from arq.connections import ArqRedis
    from sqlalchemy.ext.asyncio import AsyncConnection

FIELDS = ("storage_bytes", "file_bytes", "open_uploads", "gpu_minutes_24h", "agent_requests_24h")
WINDOW_S = 24 * 3600
# Resumos na fila ou rodando por conta: cada um ocupa o agente.
MAX_OPEN_SUMMARIES = 3


def quota_exceeded(quota: str, limit: int, used: int) -> ApiProblemError:
    """403 — a conta passou de uma cota; `quota`, `limit` e `used` dizem qual e quanto."""
    return ApiProblemError(
        403,
        "quota_exceeded",
        f"A cota {quota} da conta é {limit} e o uso chegaria a {used}.",
        extra={"quota": quota, "limit": limit, "used": used},
    )


def merge(default: dict[str, Any], override: dict[str, Any] | None) -> dict[str, int | None]:
    """Cota efetiva: a sobreposição da conta, campo a campo, sobre o padrão da plataforma."""
    override = override or {}
    return {field: override[field] if field in override else default.get(field) for field in FIELDS}


async def effective(conn: AsyncConnection, owner_id: UUID) -> dict[str, int | None]:
    """Cota efetiva da conta (lê `platform_settings` e `users`)."""
    default = (await conn.execute(select(t.platform_settings.c.quotas))).scalar_one()
    override = (await conn.execute(select(t.users.c.quotas).where(t.users.c.id == owner_id))).scalar()
    return merge(default, override)


def _open_upload(now: datetime) -> Any:  # noqa: ANN401
    u = t.uploads.c
    return (u.status == "in_progress") & (u.expires_at > now)


async def storage_used(conn: AsyncConnection, owner_id: UUID) -> tuple[int, int]:
    """`(bytes guardados, uploads abertos)`: o áudio das gravações mais os uploads em andamento."""
    now = datetime.now(UTC)
    recorded = (
        await conn.execute(
            select(func.coalesce(func.sum(t.recordings.c.size_bytes), 0)).where(t.recordings.c.owner_id == owner_id)
        )
    ).scalar_one()
    uploading, count = (
        await conn.execute(
            select(func.coalesce(func.sum(t.uploads.c.size_bytes), 0), func.count()).where(
                t.uploads.c.owner_id == owner_id, _open_upload(now)
            )
        )
    ).one()
    return int(recorded) + int(uploading), int(count)


async def gpu_minutes_used(conn: AsyncConnection, owner_id: UUID) -> int:
    """Minutos de áudio despachados à GPU nas últimas 24 h (arredondado para cima)."""
    jobs, recordings = t.transcription_jobs.c, t.recordings.c
    since = datetime.now(UTC) - timedelta(seconds=WINDOW_S)
    total_ms = (
        await conn.execute(
            select(func.coalesce(func.sum(func.coalesce(recordings.duration_ms, 0)), 0))
            .select_from(t.transcription_jobs.join(t.recordings, recordings.id == jobs.recording_id))
            .where(jobs.owner_id == owner_id, jobs.dispatched_at >= since)
        )
    ).scalar_one()
    return math.ceil(int(total_ms) / 60_000)


def agent_key(owner_id: UUID | str) -> str:
    """Conjunto ordenado (pelo instante) dos pedidos da conta ao agente."""
    return f"eclume:quota:agent:{owner_id}"


async def agent_requests_used(redis: ArqRedis, owner_id: UUID) -> int:
    """Pedidos ao agente nas últimas 24 h, aparando os mais antigos."""
    key = agent_key(owner_id)
    await redis.zremrangebyscore(key, "-inf", time.time() - WINDOW_S)
    return int(await redis.zcard(key))


async def usage(conn: AsyncConnection, redis: ArqRedis, owner_id: UUID) -> dict[str, Any]:
    """Schema `Usage`: o uso da conta e a cota efetiva."""
    storage, open_uploads = await storage_used(conn, owner_id)
    return {
        "usage": {
            "storage_bytes": storage,
            "open_uploads": open_uploads,
            "gpu_minutes_24h": await gpu_minutes_used(conn, owner_id),
            "agent_requests_24h": await agent_requests_used(redis, owner_id),
        },
        "quotas": await effective(conn, owner_id),
    }


async def check_upload(conn: AsyncConnection, owner_id: UUID, size_bytes: int) -> None:
    """Recusa um upload novo que passa do tamanho por arquivo, do armazenamento ou dos abertos."""
    quotas = await effective(conn, owner_id)
    file_limit = quotas["file_bytes"]
    if file_limit is not None and size_bytes > file_limit:
        raise quota_exceeded("file_bytes", file_limit, size_bytes)
    storage, open_uploads = await storage_used(conn, owner_id)
    open_limit = quotas["open_uploads"]
    if open_limit is not None and open_uploads + 1 > open_limit:
        raise quota_exceeded("open_uploads", open_limit, open_uploads + 1)
    storage_limit = quotas["storage_bytes"]
    if storage_limit is not None and storage + size_bytes > storage_limit:
        raise quota_exceeded("storage_bytes", storage_limit, storage + size_bytes)


async def within_gpu_minutes(conn: AsyncConnection, owner_id: UUID) -> bool:
    """Se a conta ainda tem minutos de GPU na janela de 24 h."""
    limit = (await effective(conn, owner_id))["gpu_minutes_24h"]
    return limit is None or await gpu_minutes_used(conn, owner_id) < limit


async def agent_limit(conn: AsyncConnection, owner_id: UUID) -> int | None:
    """Cota efetiva de pedidos ao agente em 24 h."""
    return (await effective(conn, owner_id))["agent_requests_24h"]


# Apara a janela, compara e inscreve numa só ida ao Redis: pedidos concorrentes da mesma conta não
# leem o mesmo uso. Devolve 0 quando contou e `uso + 1` quando recusou. ARGV: agora, janela, limite
# (-1 sem limite), membro.
_TAKE = """
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
local used = redis.call('ZCARD', KEYS[1])
local limit = tonumber(ARGV[3])
if limit >= 0 and used + 1 > limit then
  return used + 1
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 0
"""

_log = logging.getLogger(__name__)


async def take_agent_request(redis: ArqRedis, owner_id: UUID, limit: int | None) -> str:
    """Conta um pedido da pessoa ao agente, atômico; devolve o token que `refund_agent_request` estorna.

    Estourada a cota de 24 h, 403 `quota_exceeded`.
    """
    member = str(uuid4())
    script = redis.register_script(_TAKE)
    refused = int(
        await script(
            keys=[agent_key(owner_id)],
            args=[time.time(), WINDOW_S, -1 if limit is None else limit, member],
        )
    )
    if refused:
        raise quota_exceeded("agent_requests_24h", limit, refused)
    return member


async def refund_agent_request(redis: ArqRedis, owner_id: UUID, token: str) -> None:
    """Devolve a cota de um pedido que não saiu; idempotente e nunca levanta (não mascara o erro original)."""
    try:
        await redis.zrem(agent_key(owner_id), token)
    except Exception:  # noqa: BLE001 — o estorno nunca mascara o erro original
        _log.exception("não foi possível estornar a cota do agente de %s", owner_id)


class AgentCharge:
    """O token da cota gasta dentro de `refunding`; vazio até a cobrança acontecer."""

    token: str | None = None


@asynccontextmanager
async def refunding(redis: ArqRedis, owner_id: UUID) -> AsyncIterator[AgentCharge]:
    """Estorna a cota cobrada (`charge.token`) se o bloco falhar depois; re-levanta o erro."""
    charge = AgentCharge()
    try:
        yield charge
    except BaseException:
        if charge.token is not None:
            await refund_agent_request(redis, owner_id, charge.token)
        raise


async def charge_agent(conn: AsyncConnection, redis: ArqRedis, owner_id: UUID) -> str:
    """`take_agent_request` com a cota efetiva da conta; devolve o token."""
    return await take_agent_request(redis, owner_id, await agent_limit(conn, owner_id))


async def check_open_summaries(conn: AsyncConnection, owner_id: UUID) -> None:
    """Com `MAX_OPEN_SUMMARIES` resumos na fila ou rodando, 429 `rate_limited`."""
    s = t.summaries.c
    count = (
        await conn.execute(select(func.count()).where(s.owner_id == owner_id, s.status.in_(("queued", "running"))))
    ).scalar_one()
    if count >= MAX_OPEN_SUMMARIES:
        raise rate_limited(f"Já há {MAX_OPEN_SUMMARIES} resumos em andamento; espere um terminar.")
