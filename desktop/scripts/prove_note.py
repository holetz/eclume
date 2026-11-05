# ruff: noqa: INP001  # standalone script of the Windows proof; desktop/ is not a Python package
"""Checks through the API that a voice note recorded by the desktop app reached the library.

Signs in with the test account (`ECLUME_PROOF_EMAIL` and `ECLUME_PROOF_PASSWORD`; the old names
`ECLUME_PROVA_EMAIL` and `ECLUME_PROVA_SENHA` still work) the way the browser does
(`POST /api/v1/auth/login`, cookies `eclume_session` and `eclume_csrf`), reads the recording and
waits for the transcript. Passes when the recording is a note (`kind: note`), came from the desktop
app at the requested version (`capture.client_version`) and reached `transcribed`.

Usage:
    python desktop/scripts/prove_note.py --recording <id> --version 0.2.0 \
        [--server https://192.168.15.199:8443] [--ca <pem>] [--wait 900]

Standard library only: runs with any Python 3.12 on the workstation.
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from typing import Any

READY = "transcribed"
FAILED = "failed"


class ProofError(Exception):
    """The proof did not pass; the message says why."""


def client(ca: str | None) -> urllib.request.OpenerDirector:
    """An opener with cookies and the eclume CA (the one the app pinned, or the system's)."""
    context = ssl.create_default_context(cafile=ca) if ca else ssl.create_default_context()
    return urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        urllib.request.HTTPSHandler(context=context),
    )


def request(opener: urllib.request.OpenerDirector, url: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    """GET (or POST with JSON) and the JSON response; an error status becomes `ProofError`."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")  # noqa: S310
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with opener.open(req, timeout=30) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        raise ProofError(
            f"{req.method} {url} returned {error.code}: {error.read().decode(errors='replace')}"
        ) from error


def check(recording: dict[str, Any], version: str) -> list[str]:
    """What does not match in a recording (empty when it is the desktop note at the requested version)."""
    problems = []
    if recording.get("kind") != "note":
        problems.append(f"kind is {recording.get('kind')!r}, expected 'note'")
    client_version = (recording.get("capture") or {}).get("client_version")
    if client_version != f"eclume-desktop/{version}":
        problems.append(f"capture.client_version is {client_version!r}, expected 'eclume-desktop/{version}'")
    return problems


def wait_for_note(
    opener: urllib.request.OpenerDirector, base: str, recording_id: str, version: str, wait: int
) -> dict[str, Any]:
    """Reads the recording until it is ready; the wrong note, or one that never gets ready, is `ProofError`."""
    deadline = time.monotonic() + wait
    while True:
        recording = request(opener, f"{base}/api/v1/recordings/{recording_id}")
        problems = check(recording, version)
        if problems:
            raise ProofError("; ".join(problems))
        status = recording.get("status")
        if status == READY:
            return recording
        if status == FAILED or time.monotonic() > deadline:
            raise ProofError(f"the recording stayed at {status!r}")
        time.sleep(10)


def main() -> int:
    """Signs in, waits for the transcript and checks the note; 0 when it passes."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--server", default="https://192.168.15.199:8443")
    parser.add_argument("--recording", required=True, help="the recording id on the server (the queue's remote_id)")
    parser.add_argument("--version", required=True, help="the version of the app that recorded, such as 0.2.0")
    parser.add_argument("--ca", help="PEM of the server CA (the servidor-ca.pem the app pinned)")
    parser.add_argument("--wait", type=int, default=900, help="seconds for the transcript to finish")
    args = parser.parse_args()

    # ECLUME_PROVA_EMAIL/ECLUME_PROVA_SENHA are the deprecated pt-BR names, still read.
    email = os.environ.get("ECLUME_PROOF_EMAIL") or os.environ.get("ECLUME_PROVA_EMAIL")
    password = os.environ.get("ECLUME_PROOF_PASSWORD") or os.environ.get("ECLUME_PROVA_SENHA")
    if not email or not password:
        sys.stderr.write("set ECLUME_PROOF_EMAIL and ECLUME_PROOF_PASSWORD\n")
        return 2

    base = args.server.rstrip("/")
    opener = client(args.ca)
    try:
        request(opener, f"{base}/api/v1/auth/login", {"email": email, "password": password})
        recording = wait_for_note(opener, base, args.recording, args.version, args.wait)
    except (ProofError, urllib.error.URLError) as error:
        sys.stderr.write(f"note proof failed: {error}\n")
        return 1

    summary = {
        "id": recording["id"],
        "title": recording.get("title"),
        "kind": recording["kind"],
        "status": recording["status"],
        "duration_ms": recording.get("duration_ms"),
        "client_version": recording["capture"]["client_version"],
    }
    sys.stdout.write(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
