"""Smoke of the eclume stack, through the public API, with the standard library only.

Proves the whole path: health, SPA, `/downloads/`, the open signup with the notice, the admin
session (the summary provider already registered, of any kind), the user session (multipart upload
of an audio, diarized transcription on the GPU and a summary by that provider) and the
summary-centred recording (holetz/eclume#34): manual edit, adjustment chat that reads the
transcript, back to the generated one, markers, library by the day's interval and the four export formats.

The default target is staging (`https://127.0.0.1:18444`, `staging.sh up` on the host; from the
workstation, `ssh -L 18444:127.0.0.1:18444`), with the disposable account in `~/eclume-staging/conta`:

    python3 deploy/smoke_prod.py --ca ca.crt --email staging@eclume.invalid < password

Against production (`ECLUME_PUBLIC_URL`, `https://192.168.15.199:8443`) only the read part runs —
health, SPA, `/downloads/`, signup and admin session — with `--read-only`; without it, it refuses
with exit 2 before any request:

    ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password \
      | python3 deploy/smoke_prod.py --url https://192.168.15.199:8443 --ca eclume-root.crt --read-only

With `--pipeline`, it proves the automatic processing (holetz/eclume#33): it retranscribes the
recording (the one in `--recording`, a real library recording, or the fixture audio's) and waits for
the six pipeline steps — received, preprocessing, transcription, fields, agenda type and summary —
all `done`.

The smoke registers no provider: it uses the enabled one that declares `summaries` (the one the
server would use) or, with none declaring it, the enabled one without a purpose; `--provider <id>`
picks another. With none, it fails saying what to register in the panel (docs/standards/code/server-agentes.md).

The password comes from stdin (or `ECLUME_SMOKE_PASSWORD`) and serves both accounts with the same
e-mail: the admin one and the user one, which migration 008 split with the same hash. After an
`admin set-password`, the admin password goes in `ECLUME_SMOKE_ADMIN_PASSWORD`. An audio already
sent comes back as `deduplicated`, and the smoke checks the transcript it already has. Runbook:
docs/project/deploy-producao.md.

`--somente-leitura` is the deprecated pt-BR spelling of `--read-only`, still accepted (and hidden
from --help): the staging.sh installed on the host passes it until the next deploy replaces it.
"""

# ruff: noqa: INP001 — standalone operations script, outside any package

from __future__ import annotations

import argparse
import hashlib
import http.cookiejar
import json
import os
import select
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable
    from email.message import Message

STAGING = "https://127.0.0.1:18444"
PRODUCTION = "https://192.168.15.199:8443"
FIXTURE = Path(__file__).resolve().parent.parent / "worker-gpu" / "tests" / "fixtures" / "two-voices.ogg"


class Api:
    """Minimal client: session cookies and double-submit CSRF on the mutating methods.

    The user and admin sessions share the same cookie jar: the admin one only travels to
    `/api/v1/admin`, and each area echoes its own CSRF cookie.
    """

    def __init__(self, base: str, ca: str | None) -> None:
        """Client for `base`, trusting `ca` (or the system CAs)."""
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        context = ssl.create_default_context(cafile=ca)
        self.context = context
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=context), urllib.request.HTTPCookieProcessor(self.jar)
        )

    def _csrf(self, url: str) -> str | None:
        name = "eclume_admin_csrf" if "/api/v1/admin/" in url else "eclume_csrf"
        return next((c.value for c in self.jar if c.name == name), None)

    def raw(
        self, method: str, url: str, body: bytes | None = None, headers: dict[str, str] | None = None
    ) -> tuple[int, Message, bytes]:
        """Raw request: status, headers (case-insensitive: Caddy sends `Etag`) and body, without raising on error."""
        full = url if url.startswith("http") else self.base + url
        request = urllib.request.Request(full, data=body, method=method, headers=headers or {})  # noqa: S310 — URL of the stack itself
        csrf = self._csrf(full)
        if method not in {"GET", "HEAD"} and csrf:
            request.add_header("X-CSRF-Token", csrf)
        try:
            with self.opener.open(request, timeout=60) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.headers, exc.read()

    def oversized(self, path: str, size: int) -> int:
        """Status of a POST of `size` bytes that the proxy refuses mid-upload.

        Caddy answers 413 and closes the connection without reading the rest of the body: `urllib`,
        which only reads the response after sending everything, sees the connection drop. Here sending
        and reading alternate on a non-blocking socket, as curl does, and sending stops when the
        response arrives or the proxy closes. With no status read, 0.
        """
        parts = urllib.parse.urlsplit(self.base)
        host, port = parts.hostname or "", parts.port or 443
        head = (
            f"POST {path} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\n"
            f"Content-Length: {size}\r\nConnection: close\r\n\r\n"
        ).encode()
        chunk = b" " * 65536
        received = b""
        sent = 0
        with self.context.wrap_socket(socket.create_connection((host, port), timeout=30), server_hostname=host) as tls:
            tls.sendall(head)
            tls.setblocking(False)  # noqa: FBT003 — the socket API is positional
            deadline = time.monotonic() + 60
            while b"\r\n" not in received and time.monotonic() < deadline:
                try:
                    data = tls.recv(65536)
                except (ssl.SSLWantReadError, BlockingIOError):
                    data = None
                except OSError:
                    break
                if data == b"":
                    break
                if data:
                    received += data
                    continue
                if sent < size:
                    try:
                        sent += tls.send(chunk[: size - sent])
                    except (ssl.SSLWantWriteError, BlockingIOError):
                        select.select([tls], [tls], [], 0.05)
                    except OSError:
                        sent = size  # the proxy closed the write side: only the response is left to read
                else:
                    select.select([tls], [], [], 0.5)
        try:
            return int(received.split(b" ", 2)[1])
        except (IndexError, ValueError):
            return 0

    def json(
        self, method: str, url: str, payload: dict[str, Any] | None = None, expect: tuple[int, ...] = (200,)
    ) -> dict[str, Any]:
        """JSON request; a status outside `expect` ends the smoke."""
        body = None if payload is None else json.dumps(payload).encode()
        status, _, data = self.raw(method, url, body, {"Content-Type": "application/json"} if body else None)
        if status not in expect:
            _fail(f"{method} {url} → {status}: {data[:400].decode(errors='replace')}")
        return json.loads(data) if data else None


def _fail(message: str) -> None:
    print(f"FAILURE: {message}", file=sys.stderr)  # noqa: T201
    raise SystemExit(1)


def _step(message: str) -> None:
    print(f"· {message}", flush=True)  # noqa: T201


def _wait(what: str, check: Callable[[], dict[str, Any] | None], timeout_s: int, interval_s: int = 5) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        result = check()
        if result is not None:
            return result
        time.sleep(interval_s)
    _fail(f"timed out waiting for {what}")
    raise AssertionError


def _public_checks(api: Api) -> None:
    status, headers, _ = api.raw("GET", "/api/v1/health")
    if status != 200:  # noqa: PLR2004
        _fail(f"health → {status}")
    _security_headers("/api/v1/health", headers)
    for path in ("/", "/entrar"):
        status, headers, body = api.raw("GET", path)
        if status != 200 or b'id="root"' not in body:  # noqa: PLR2004
            _fail(f"{path} did not return the SPA index.html ({status})")
        if "immutable" in headers.get("Cache-Control", ""):
            _fail(f"{path} came out with a long cache: {headers.get('Cache-Control')}")
        _security_headers(path, headers)
        csp = headers.get("Content-Security-Policy") or ""
        if "default-src 'self'" not in csp or "'wasm-unsafe-eval'" not in csp:
            _fail(f"{path} without the SPA CSP (edge rules): {csp!r}")
    # A chunk of an earlier deploy: 404 without a long cache, never index.html kept for a year.
    status, headers, _ = api.raw("GET", "/assets/missing-smoke.js")
    if status != 404 or "immutable" in headers.get("Cache-Control", ""):  # noqa: PLR2004
        _fail(f"missing /assets → {status} {headers.get('Cache-Control')}")
    status, headers, _ = api.raw("GET", "/downloads/latest.json")
    if status != 200 or "json" not in headers.get("Content-Type", ""):  # noqa: PLR2004
        _fail(f"/downloads/latest.json → {status} {headers.get('Content-Type')}")
    signup = api.json("GET", "/api/v1/auth/signup")
    if not signup["open"] or not signup["notice"]["version"]:
        _fail(f"signup closed or without the notice: {signup}")
    _body_limits(api)
    _step(
        f"health, SPA, security headers, missing asset 404, /downloads/latest.json, body ceilings and "
        f"open signup (notice v{signup['notice']['version']}) ok"
    )


def _security_headers(path: str, headers: Any) -> None:  # noqa: ANN401 — `email.message.Message`
    expected = {"X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"}
    wrong = {name: headers.get(name) for name, value in expected.items() if headers.get(name) != value}
    if wrong or "frame-ancestors 'none'" not in (headers.get("Content-Security-Policy") or ""):
        _fail(f"{path} without the security headers: {wrong} CSP={headers.get('Content-Security-Policy')!r}")


def _body_limits(api: Api) -> None:
    """413 from the server (problem+json) above the credential route ceiling and from Caddy above 9 MiB."""
    json_type = {"Content-Type": "application/json"}
    status, headers, body = api.raw("POST", "/api/v1/auth/login", b" " * (65 * 1024), json_type)
    if status != 413 or b"payload_too_large" not in body:  # noqa: PLR2004
        _fail(f"login with 65 KiB → {status} {headers.get('Content-Type')}: {body[:200]!r}")
    status = api.oversized("/api/v1/recordings", 10 * 1024 * 1024)
    if status != 413:  # noqa: PLR2004
        _fail(f"10 MiB body on the API → {status}, expected 413 from the edge Caddy")


def choose_provider(items: list[dict[str, Any]], wanted: str | None = None) -> dict[str, Any]:
    """The summary provider: the requested one, the enabled `summaries` one or the enabled one without a purpose.

    `ValueError` with the message for the operator when none fits.
    """
    if wanted is not None:
        item = next((i for i in items if i["id"] == wanted), None)
        if item is None:
            raise ValueError(f"provider {wanted} does not exist")
        if not item["enabled"]:
            raise ValueError(f"provider {item['name']} is disabled")
        return item
    enabled = [i for i in items if i["enabled"]]
    for item in enabled:
        if "summaries" in item["used_for"]:
            return item
    for item in enabled:
        if not item["used_for"]:
            return item
    raise ValueError(
        "no provider enabled for summaries: register one in the panel (Admin → Agentes) "
        "with the summaries purpose — ollama, openai-compatible, anthropic or claude-cli"
    )


def _provider(api: Api, wanted: str | None) -> str:
    try:
        item = choose_provider(api.json("GET", "/api/v1/admin/agent-providers")["items"], wanted)
    except ValueError as error:
        _fail(str(error))
    _step(f"summary provider: {item['name']} ({item['kind']}, {item['model']})")
    return item["id"]


def _upload(api: Api, audio: Path) -> str:
    data = audio.read_bytes()
    created = api.json(
        "POST",
        "/api/v1/uploads",
        {
            "filename": audio.name,
            "content_type": "audio/ogg; codecs=opus",
            "size_bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "title": "Production smoke — two voices",
            "language": "pt-BR",
            "source": "upload",
        },
        expect=(200, 201),
    )
    if created["status"] == "deduplicated":
        _step(f"audio already sent before: recording {created['recording_id']}")
        return created["recording_id"]
    size = created["part_size"]
    # A resumed upload (same sha256, still in_progress) only brings the URLs of the missing parts.
    parts = [{"part_number": p["part_number"], "etag": p["etag"]} for p in created["parts_received"]]
    for part in created["parts"]:
        number = part["part_number"]
        chunk = data[(number - 1) * size : number * size]
        status, headers, body = api.raw(part["method"], part["url"], chunk, part.get("headers") or {})
        if status != 200:  # noqa: PLR2004
            _fail(f"PUT part {number} → {status}: {body[:200]!r}")
        parts.append({"part_number": number, "etag": headers["ETag"]})
    parts.sort(key=lambda p: p["part_number"])
    recording = api.json("POST", f"/api/v1/uploads/{created['id']}/complete", {"parts": parts}, expect=(200, 201))
    recording_id = recording.get("id") or recording.get("recording_id")
    _step(f"upload complete: {len(parts)} part(s), recording {recording_id}")
    return recording_id


def _transcript_of(api: Api, recording_id: str, timeout_s: int) -> dict[str, Any]:
    def done() -> dict[str, Any] | None:
        recording = api.json("GET", f"/api/v1/recordings/{recording_id}")
        if recording["status"] == "failed":
            _fail(f"transcription failed: {recording['job'].get('error')}")
        if recording["status"] == "transcribed":
            return recording
        return None

    _step(f"waiting for the transcription on the GPU (up to {timeout_s} s; the first job downloads the models)")
    started = time.monotonic()
    recording = _wait("the transcription", done, timeout_s)
    transcript = api.json("GET", f"/api/v1/transcripts/{recording['transcript_id']}")
    speakers = [s for s in transcript["speakers"] if s.get("talk_ms", 0) > 0]
    _step(
        f"transcription in {time.monotonic() - started:.0f} s: {len(transcript['segments'])} segments, "
        f"{len(speakers)} speakers, engine {transcript['engine']}"
    )
    if len(speakers) < 2:  # noqa: PLR2004
        _fail("diarization did not separate the dialogue's 2 speakers")
    for segment in transcript["segments"][:3]:
        _step(f"  [{segment['speaker_id']}] {segment['text']}")
    return transcript


def _summarize(api: Api, transcript_id: str, provider_id: str, timeout_s: int) -> None:
    agenda_type = api.json("GET", "/api/v1/agenda-types")["items"][0]
    summary = api.json(
        "POST",
        f"/api/v1/transcripts/{transcript_id}/summaries",
        {"agenda_type_id": agenda_type["id"], "provider_id": provider_id},
        expect=(202,),
    )

    def done() -> dict[str, Any] | None:
        current = api.json("GET", f"/api/v1/summaries/{summary['id']}")
        if current["status"] == "failed":
            _fail(f"summary failed: {current.get('error')}")
        return current if current["status"] == "done" else None

    result = _wait("the summary", done, timeout_s)
    first = next((line for line in result["content_md"].splitlines() if line.strip()), "")
    _step(f"summary '{agenda_type['name']}' by {result['model']}: {first[:100]}")


EXPORTS = {
    "txt": "text/plain",
    "srt": "application/x-subrip",
    "md": "text/markdown",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


def _edit_and_chat(api: Api, recording_id: str, timeout_s: int) -> None:
    """Manual edit (`manual` version), chat that reads the transcript (`chat` version) and back to the generated one."""
    url = f"/api/v1/recordings/{recording_id}/summary"
    current = api.json("GET", url)["current"]
    edited = api.json(
        "PUT",
        url,
        {"content_md": current["content_md"] + "\n\n_Revised in the smoke._", "base_version": current["version"]},
    )
    if edited["origin"] != "manual":
        _fail(f"the edit did not become a manual version: {edited}")
    _step(f"summary edited by hand: version {edited['version']} ({edited['origin']})")

    request = "Say who speaks first in the meeting and add that at the start of the summary."
    exchange = api.json("POST", f"{url}/chat", {"message": request}, expect=(202,))
    started = time.monotonic()

    def answered() -> dict[str, Any] | None:
        reply = api.json("GET", f"/api/v1/summary-chat-messages/{exchange['reply']['id']}")
        if reply["status"] == "failed":
            _fail(f"the chat failed: {reply['error']}")
        return reply if reply["status"] == "done" else None

    reply = _wait("the chat reply", answered, timeout_s, interval_s=2)
    if not reply["reads"]:
        _fail(f"the chat answered without reading the transcript: {reply['content']}")
    if reply["summary_id"] is None:
        _fail(f"the chat did not create the chat version: {reply['error'] or reply['content']}")
    state = api.json("GET", url)
    if state["current"]["origin"] != "chat":
        _fail(f"the current version is not the chat one: {state['current']['origin']}")
    _step(f"chat in {time.monotonic() - started:.0f} s, reads {reply['reads']}: {reply['content'][:100]}")

    reverted = api.json("POST", f"{url}/revert", expect=(201,))
    if reverted["restored_from_id"] != state["generated"]["id"]:
        _fail(f"reverting to the generated one did not restore it: {reverted}")
    _step(f"back to the generated one: version {reverted['version']} ({api.json('GET', url)['version_count']} kept)")


def _markers_and_library(api: Api, recording: dict[str, Any]) -> None:
    """Two markers and the recording in the library of its day, meetings only."""
    markers = [{"client_id": str(uuid.uuid4()), "at_ms": at_ms, "note": "smoke"} for at_ms in (1000, 3000)]
    page = api.json(
        "POST", f"/api/v1/recordings/{recording['id']}/markers", {"markers": markers, "device_name": "smoke"}
    )
    if len(page["items"]) < 2:  # noqa: PLR2004
        _fail(f"the markers were not saved: {page}")
    count = api.json("GET", f"/api/v1/recordings/{recording['id']}")["marker_count"]
    _step(f"markers saved: {count} on the recording")

    day = datetime.fromisoformat(recording["recorded_at"]).replace(hour=0, minute=0, second=0, microsecond=0)
    query = urllib.parse.urlencode(
        {
            "from": day.isoformat(),
            "to": (day + timedelta(days=1)).isoformat(),
            "kind": "meeting",
            "sort": "recorded_asc",
            "limit": 200,
        }
    )
    listed = api.json("GET", f"/api/v1/recordings?{query}")["items"]
    if recording["id"] not in {item["id"] for item in listed}:
        _fail(f"the recording did not show up in the library of {day.date()}")
    _step(f"library of {day.date()} with kind=meeting: {len(listed)} recording(s)")


def _exports(api: Api, recording_id: str) -> None:
    """The four formats, with the right Content-Type; the DOCX opens as a zip (`PK`)."""
    sizes = []
    for export_format, media in EXPORTS.items():
        status, headers, body = api.raw("GET", f"/api/v1/recordings/{recording_id}/export?format={export_format}")
        if status != 200 or not (headers.get("Content-Type") or "").startswith(media):  # noqa: PLR2004
            _fail(f"export {export_format} → {status} {headers.get('Content-Type')}: {body[:200]!r}")
        if export_format == "docx" and body[:2] != b"PK":
            _fail("the DOCX is not an Office file (zip)")
        sizes.append(f"{export_format} {len(body)} B")
    _step(f"export: {', '.join(sizes)}")


PIPELINE = ("received", "preprocessing", "transcription", "fields", "agenda_type", "summary")


def _pipeline(api: Api, recording_id: str, timeout_s: int) -> None:
    """Retranscribes the recording and waits for the six steps `done`; any other final outcome fails."""
    retried = api.json("POST", f"/api/v1/recordings/{recording_id}/retranscribe", expect=(202,))
    _step(f"retranscription of recording {recording_id} queued (steps: {_states(retried)})")

    def finished() -> dict[str, Any] | None:
        recording = api.json("GET", f"/api/v1/recordings/{recording_id}")
        states = {step["step"]: step["state"] for step in recording["pipeline"]}
        if any(state in {"failed", "skipped"} for state in states.values()):
            _fail(f"a step did not end done: {json.dumps(recording['pipeline'], ensure_ascii=False)}")
        return recording if all(states[step] == "done" for step in PIPELINE) else None

    started = time.monotonic()
    recording = _wait("the six pipeline steps", finished, timeout_s)
    _step(f"pipeline complete in {time.monotonic() - started:.0f} s:")
    for step in recording["pipeline"]:
        _step(f"  {step['step']:<14} {step['state']:<5} {step['duration_ms']} ms")
    fields = api.json("GET", f"/api/v1/recordings/{recording_id}/fields")["items"]
    auto = [f"{item['field']['key']}={item['value']!r}" for item in fields if item["origin"] == "auto"]
    _step(f"automatic fields: {', '.join(auto) or 'none'}")
    agenda_type = recording["agenda_type"] or {}
    _step(f"agenda type: {agenda_type.get('name')} ({agenda_type.get('origin')}); title: {recording['title']}")
    summaries = api.json("GET", f"/api/v1/transcripts/{recording['transcript_id']}/summaries")["items"]
    automatic = next(s for s in summaries if s["trigger"] == "automatic" and s["status"] == "done")
    first = next((line for line in (automatic["content_md"] or "").splitlines() if line.strip()), "")
    _step(f"automatic summary '{automatic['agenda_type']['name']}' by {automatic['model']}: {first[:100]}")


def _states(recording: dict[str, Any]) -> str:
    return ", ".join(f"{step['step']}={step['state']}" for step in recording["pipeline"])


def is_production(url: str) -> bool:
    """Whether `url` points at production: the one in `PRODUCTION` or the one in `ECLUME_PUBLIC_URL`."""
    targets = {PRODUCTION, os.environ.get("ECLUME_PUBLIC_URL") or PRODUCTION}
    return urllib.parse.urlsplit(url).netloc.lower() in {urllib.parse.urlsplit(a).netloc.lower() for a in targets}


def main() -> int:
    """Runs the smoke and returns the exit code."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default=STAGING, help="default: staging; production only with --read-only")
    parser.add_argument("--ca", help="root CA of eclume's Caddy (default: the system CAs)")
    parser.add_argument(
        "--email",
        default=os.environ.get("ECLUME_ADMIN_EMAIL"),
        help="e-mail of both accounts (default: $ECLUME_ADMIN_EMAIL)",
    )
    parser.add_argument("--admin-email", help="e-mail of the admin account (default: --email)")
    parser.add_argument("--audio", type=Path, default=FIXTURE)
    parser.add_argument("--timeout", type=int, default=1200, help="maximum wait for the transcription, in seconds")
    parser.add_argument("--pipeline", action="store_true", help="proves the six steps of the automatic processing")
    parser.add_argument("--recording", help="with --pipeline: the recording to retranscribe (default: the audio's)")
    parser.add_argument("--provider", help="id of the summary provider (default: the summaries one)")
    parser.add_argument(
        "--read-only",
        action="store_true",
        help="only health, SPA, /downloads/, signup and admin session (the only mode accepted on production)",
    )
    # Deprecated pt-BR spelling, hidden: the host's installed staging.sh passes it until the next deploy.
    parser.add_argument("--somente-leitura", dest="read_only", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if is_production(args.url) and not args.read_only:
        print(f"{args.url} is production: the smoke writes data; use staging or --read-only.", file=sys.stderr)  # noqa: T201
        return 2
    if not args.email:
        _fail("give the account through --email or ECLUME_ADMIN_EMAIL")
    password = os.environ.get("ECLUME_SMOKE_PASSWORD") or sys.stdin.readline().strip()
    if not password:
        _fail("give the password through stdin or ECLUME_SMOKE_PASSWORD")

    api = Api(args.url, args.ca)
    _public_checks(api)
    admin_email = args.admin_email or args.email
    admin_password = os.environ.get("ECLUME_SMOKE_ADMIN_PASSWORD") or password
    api.json("POST", "/api/v1/admin/auth/login", {"email": admin_email, "password": admin_password}, expect=(204,))
    _step(f"admin session ok: {api.json('GET', '/api/v1/admin/me')['email']}")
    if args.read_only:
        print("OK (read-only)")  # noqa: T201
        return 0
    provider_id = _provider(api, args.provider)
    api.json("POST", "/api/v1/auth/login", {"email": args.email, "password": password}, expect=(200, 204))
    me = api.json("GET", "/api/v1/me")
    _step(f"user session ok: {me['user']['email']} (notice pending: {me['notice_required']})")
    if args.pipeline:
        _pipeline(api, args.recording or _upload(api, args.audio), args.timeout)
    else:
        recording_id = _upload(api, args.audio)
        transcript = _transcript_of(api, recording_id, args.timeout)
        _summarize(api, transcript["id"], provider_id, 600)
        _edit_and_chat(api, recording_id, 600)
        _markers_and_library(api, api.json("GET", f"/api/v1/recordings/{recording_id}"))
        _exports(api, recording_id)
    print("OK")  # noqa: T201
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
