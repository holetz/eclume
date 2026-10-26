"""JSON log format and `ContextVar` context."""

from __future__ import annotations

import io
import json
import logging

from eclume_engines import logs


def _lines(stream: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in stream.getvalue().splitlines()]


def test_json_line_with_basic_fields():
    stream = io.StringIO()
    logs.configure_logs(stream=stream)
    logging.getLogger("eclume_server.test").info("hello %s", "world")
    (line,) = _lines(stream)
    assert line["msg"] == "hello world"
    assert line["level"] == "INFO"
    assert line["logger"] == "eclume_server.test"
    assert line["ts"].endswith("Z")
    assert "T" in line["ts"]
    assert "request_id" not in line
    assert "job_id" not in line


def test_context_is_emitted_when_set():
    stream = io.StringIO()
    logs.configure_logs(stream=stream)
    token = logs.request_id.set("req-1")
    logs.job_context("job-9", "rec-3", 2)
    try:
        logging.getLogger("eclume_worker.jobs").info("running")
    finally:
        logs.request_id.reset(token)
        logs.job_context(None)
    (line,) = _lines(stream)
    assert line["request_id"] == "req-1"
    assert line["job_id"] == "job-9"
    assert line["recording_id"] == "rec-3"
    assert line["revision"] == 2


def test_idempotent_and_covers_uvicorn_and_arq():
    first = io.StringIO()
    logs.configure_logs(stream=first)
    stream = io.StringIO()
    logs.configure_logs(stream=stream)
    logging.getLogger("arq.worker").info("a")
    logging.getLogger("uvicorn.error").info("b")
    logging.getLogger("uvicorn.access").info("GET /x?sig=secret 200")
    assert [line["msg"] for line in _lines(stream)] == ["a", "b"]
    assert first.getvalue() == ""


def test_arq_cron_only_shows_up_on_warning():
    stream = io.StringIO()
    logs.configure_logs(stream=stream)
    arq = logging.getLogger("arq.worker")
    arq.info("%6.2fs → %s(%s)", 0.0, "cron:reap_stalled_jobs:1:cron:reap_stalled_jobs", "")
    arq.info("%6.2fs → %s(%s)", 0.0, "abc:ingest_transcript", "")
    arq.warning("%6.2fs ! %s max retries %d exceeded", 1.0, "cron:x:cron:x", 3)
    assert [line["level"] for line in _lines(stream)] == ["INFO", "WARNING"]
    assert "ingest_transcript" in _lines(stream)[0]["msg"]


def test_exception_goes_in_the_exc_field():
    stream = io.StringIO()
    logs.configure_logs(stream=stream)
    try:
        int("boom")
    except ValueError:
        logging.getLogger("eclume_engines.x").exception("failed")
    (line,) = _lines(stream)
    assert "ValueError" in line["exc"]


def test_context_read_from_the_job_id():
    stream = io.StringIO()
    logs.configure_logs(stream=stream)
    logs.job_context("ingest_transcript:rec-7:3")
    logging.getLogger("eclume_server.worker").info("a")
    logs.job_context("summarize:abc")
    logging.getLogger("eclume_server.worker").info("b")
    logs.job_context(None)
    first_line, second_line = _lines(stream)
    assert first_line["recording_id"] == "rec-7"
    assert first_line["revision"] == 3
    assert second_line["job_id"] == "summarize:abc"
    assert "recording_id" not in second_line
