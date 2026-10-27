"""Separation of the `eclume:default` and `eclume:agents` queues in the arq worker parameters."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from typing import TYPE_CHECKING, Any

import redis

from eclume_server.config import Settings
from eclume_server.worker import agent_worker_settings, worker_settings

if TYPE_CHECKING:
    from eclume_server_testing.harness import Services

AGENT_JOBS = {
    "summarize",
    "fill_fields",
    "detect_agenda_type",
    "run_preview",
    "summary_chat",
    "base_chat",
    "agent_turn",
    "agent_action",
}


def _names(params: dict[str, Any]) -> set[str]:
    return {getattr(f, "name", None) or f.__name__ for f in params["functions"]}


def test_default_queue_no_longer_runs_agent_jobs():
    default = _names(worker_settings(Settings()))
    assert default.isdisjoint(AGENT_JOBS)
    assert {"ingest_transcript", "transcription_failed", "purge_embedding_objects"} <= default


def test_agents_queue_runs_only_agent_jobs_and_no_cron():
    params = agent_worker_settings(Settings())
    assert _names(params) == AGENT_JOBS
    assert not params["cron_jobs"]


def test_poll_delay_per_queue():
    assert worker_settings(Settings())["poll_delay"] == 2
    assert agent_worker_settings(Settings())["poll_delay"] == 1


def test_single_worker_starts_both_queues_and_stops_on_sigterm(services: Services):
    env = os.environ | {
        f"ECLUME_{name.upper()}": str(value) for name, value in services.settings.model_dump().items() if value
    }
    client = redis.Redis.from_url(services.settings.redis_url)
    keys = ["eclume:default:health-check", "eclume:agents:health-check"]
    client.delete(*keys)
    proc = subprocess.Popen(
        [sys.executable, "-m", "eclume_server.cli", "worker"], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT
    )
    try:
        deadline = time.monotonic() + 30
        while client.exists(*keys) < len(keys):
            assert proc.poll() is None, proc.stdout.read().decode() if proc.stdout else ""
            assert time.monotonic() < deadline, "the two health-check keys did not appear"
            time.sleep(0.2)
        proc.send_signal(signal.SIGTERM)
        output, _ = proc.communicate(timeout=20)
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    assert proc.returncode == 0, output.decode()
    assert client.exists(*keys) == 0  # each worker deleted its own key on shutdown
    assert output.decode().count("shutdown on SIGTERM") == 2
