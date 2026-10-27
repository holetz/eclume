"""Per-account quotas: effective quota, usage in `GET /me/usage` and the refusals of `POST /uploads`."""

from __future__ import annotations

import asyncio
import hashlib
from typing import TYPE_CHECKING, Any

from arq.connections import RedisSettings, create_pool

from eclume_server.previews import create_preview
from eclume_server.problems import ApiProblemError
from eclume_server.quotas import agent_requests_used, merge, refund_agent_request, take_agent_request
from eclume_server_testing.api import audio_bytes, override_quotas, upload_file

if TYPE_CHECKING:
    from collections.abc import Callable

    from eclume_server_testing.api import Account, Api
    from eclume_server_testing.harness import Services

KIB = 1024


def _create(api: Api, data: bytes) -> Any:  # noqa: ANN401
    return api.post(
        "/api/v1/uploads",
        json={
            "filename": "reuniao.opus",
            "content_type": "audio/ogg; codecs=opus",
            "size_bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        },
    )


def test_effective_quota_overrides_field_by_field():
    default = {"storage_bytes": 10, "file_bytes": 5, "open_uploads": 3, "gpu_minutes_24h": 60}
    assert merge(default, {"file_bytes": None, "open_uploads": 1}) == {
        "storage_bytes": 10,
        "file_bytes": None,
        "open_uploads": 1,
        "gpu_minutes_24h": 60,
        "agent_requests_24h": None,
    }
    assert merge(default, None)["file_bytes"] == 5


def test_account_usage(as_user: Callable[[Account], Api], make_user: Callable[..., Account]):
    account = make_user()
    api = as_user(account)
    fresh = api.get("/api/v1/me/usage")
    assert fresh.status_code == 200, fresh.text
    assert fresh.json()["usage"] == {
        "storage_bytes": 0,
        "open_uploads": 0,
        "gpu_minutes_24h": 0,
        "agent_requests_24h": 0,
    }
    assert fresh.json()["quotas"]["open_uploads"] == 3

    data = audio_bytes(64 * KIB, seed="uso")
    upload_file(api, data)
    assert _create(api, audio_bytes(32 * KIB, seed="aberto")).status_code == 201
    usage = api.get("/api/v1/me/usage").json()["usage"]
    assert usage["storage_bytes"] == 96 * KIB
    assert usage["open_uploads"] == 1


def test_upload_refused_by_quota(
    as_user: Callable[[Account], Api], make_user: Callable[..., Account], services: Services
):
    account = make_user()
    api = as_user(account)

    override_quotas(services, api, {"file_bytes": 16 * KIB})
    big = _create(api, audio_bytes(32 * KIB, seed="grande"))
    assert big.status_code == 403
    assert big.json() | {"detail": None} == big.json() | {
        "code": "quota_exceeded",
        "quota": "file_bytes",
        "limit": 16 * KIB,
        "used": 32 * KIB,
        "detail": None,
    }

    override_quotas(services, api, {"open_uploads": 1})
    assert _create(api, audio_bytes(8 * KIB, seed="um")).status_code == 201
    second = _create(api, audio_bytes(8 * KIB, seed="dois"))
    assert second.status_code == 403
    assert (second.json()["quota"], second.json()["used"]) == ("open_uploads", 2)

    override_quotas(services, api, {"open_uploads": None, "storage_bytes": 20 * KIB})
    full = _create(api, audio_bytes(16 * KIB, seed="tres"))
    assert full.status_code == 403
    assert (full.json()["quota"], full.json()["used"]) == ("storage_bytes", 24 * KIB)

    # Resuming the same file is not a new upload: it does not go through the quota.
    assert _create(api, audio_bytes(8 * KIB, seed="um")).status_code == 201

    override_quotas(services, api, None)
    assert _create(api, audio_bytes(16 * KIB, seed="tres")).status_code == 201


# --- agent quota: atomic and given back when the request does not go out --------------------------


def _redis_run(services: Services, work: Callable[[Any], Any]) -> Any:  # noqa: ANN401
    async def go() -> Any:  # noqa: ANN401
        redis = await create_pool(RedisSettings.from_dsn(services.settings.redis_url))
        try:
            return await work(redis)
        finally:
            await redis.aclose()

    return asyncio.run(go())


def test_concurrent_requests_pass_exactly_the_limit(services: Services, make_user: Callable[..., Account]):
    owner = make_user().user_id
    limit, requests = 5, 12

    async def work(redis: Any) -> tuple[list[Any], int]:  # noqa: ANN401
        results = await asyncio.gather(
            *(take_agent_request(redis, owner, limit) for _ in range(requests)), return_exceptions=True
        )
        return results, await agent_requests_used(redis, owner)

    results, used = _redis_run(services, work)
    refused = [r for r in results if isinstance(r, ApiProblemError)]
    assert len(results) - len(refused) == limit
    assert len(refused) == requests - limit
    assert all(r.status_code == 403 and r.code == "quota_exceeded" for r in refused)
    assert used == limit


def test_refund_gives_the_quota_back_and_is_idempotent(services: Services, make_user: Callable[..., Account]):
    owner = make_user().user_id

    async def work(redis: Any) -> list[int]:  # noqa: ANN401
        first = await take_agent_request(redis, owner, None)  # no limit still counts
        await take_agent_request(redis, owner, None)
        counted = await agent_requests_used(redis, owner)
        await refund_agent_request(redis, owner, first)
        await refund_agent_request(redis, owner, first)
        return [counted, await agent_requests_used(redis, owner)]

    assert _redis_run(services, work) == [2, 1]


def test_enqueue_failure_refunds_the_quota(services: Services, make_user: Callable[..., Account]):
    owner = make_user().user_id

    async def work(redis: Any) -> tuple[int, int, int]:  # noqa: ANN401
        before = await agent_requests_used(redis, owner)

        async def broken(*_args: Any, **_kwargs: Any) -> None:  # noqa: ANN401
            msg = "queue is down"
            raise RuntimeError(msg)

        redis.enqueue_job = broken
        try:
            await create_preview(redis, owner, "tags", {}, agent_quota=3)
        except RuntimeError:
            failed = 1
        else:
            failed = 0
        return before, failed, await agent_requests_used(redis, owner)

    before, failed, after = _redis_run(services, work)
    assert failed == 1
    assert after == before == 0
