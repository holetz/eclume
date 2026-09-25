"""Smoke do stack de produção do eclume, pela API pública, só com a biblioteca padrão.

Prova o caminho inteiro: health, SPA, `/downloads/`, login, provider `claude-cli` padrão, upload
multipart de um áudio, transcrição diarizada na GPU e um resumo gerado pelo `claude -p` do host.

    ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password \
      | python3 deploy/smoke_prod.py --ca eclume-root.crt

A senha vem do stdin (ou de `ECLUME_SMOKE_PASSWORD`). Um áudio já enviado volta como
`deduplicated`, e o smoke confere a transcrição que ele já tem. Runbook:
docs/project/deploy-producao.md.
"""

# ruff: noqa: INP001 — script avulso de operação, fora de qualquer pacote

from __future__ import annotations

import argparse
import hashlib
import http.cookiejar
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable
    from email.message import Message

FIXTURE = Path(__file__).resolve().parent.parent / "worker-gpu" / "tests" / "fixtures" / "duas-vozes.ogg"


class Api:
    """Cliente mínimo: cookies da sessão e CSRF double-submit nos métodos mutáveis."""

    def __init__(self, base: str, ca: str | None) -> None:
        """Cliente para `base`, confiando em `ca` (ou nas CAs do sistema)."""
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        context = ssl.create_default_context(cafile=ca)
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=context), urllib.request.HTTPCookieProcessor(self.jar)
        )

    def _csrf(self) -> str | None:
        return next((c.value for c in self.jar if c.name == "eclume_csrf"), None)

    def raw(
        self, method: str, url: str, body: bytes | None = None, headers: dict[str, str] | None = None
    ) -> tuple[int, Message, bytes]:
        """Requisição crua: status, headers (sem caixa: o Caddy manda `Etag`) e corpo, sem lançar em erro."""
        full = url if url.startswith("http") else self.base + url
        request = urllib.request.Request(full, data=body, method=method, headers=headers or {})  # noqa: S310 — URL do próprio stack
        csrf = self._csrf()
        if method not in {"GET", "HEAD"} and csrf:
            request.add_header("X-CSRF-Token", csrf)
        try:
            with self.opener.open(request, timeout=60) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.headers, exc.read()

    def json(
        self, method: str, url: str, payload: dict[str, Any] | None = None, expect: tuple[int, ...] = (200,)
    ) -> dict[str, Any]:
        """Requisição JSON; um status fora de `expect` encerra o smoke."""
        body = None if payload is None else json.dumps(payload).encode()
        status, _, data = self.raw(method, url, body, {"Content-Type": "application/json"} if body else None)
        if status not in expect:
            _fail(f"{method} {url} → {status}: {data[:400].decode(errors='replace')}")
        return json.loads(data) if data else None


def _fail(message: str) -> None:
    print(f"FALHA: {message}", file=sys.stderr)  # noqa: T201
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
    _fail(f"tempo esgotado esperando {what}")
    raise AssertionError


def _public_checks(api: Api) -> None:
    status, headers, _ = api.raw("GET", "/api/v1/health")
    if status != 200:  # noqa: PLR2004
        _fail(f"health → {status}")
    for path in ("/", "/entrar"):
        status, headers, body = api.raw("GET", path)
        if status != 200 or b'id="root"' not in body:  # noqa: PLR2004
            _fail(f"{path} não devolveu o index.html do SPA ({status})")
    status, headers, _ = api.raw("GET", "/downloads/latest.json")
    if status != 200 or "json" not in headers.get("Content-Type", ""):  # noqa: PLR2004
        _fail(f"/downloads/latest.json → {status} {headers.get('Content-Type')}")
    _step("health, SPA e /downloads/latest.json ok")


def _ensure_provider(api: Api) -> str:
    page = api.json("GET", "/api/v1/admin/agent-providers")
    for item in page["items"]:
        if item["kind"] == "claude-cli" and item["enabled"]:
            _step(f"provider claude-cli já cadastrado ({item['name']})")
            return item["id"]
    created = api.json(
        "POST",
        "/api/v1/admin/agent-providers",
        {"name": "Claude (servidor)", "kind": "claude-cli", "model": "sonnet", "enabled": True},
        expect=(201,),
    )
    _step("provider claude-cli cadastrado (o primeiro habilitado vira o padrão da organização)")
    return created["id"]


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
            "title": "Smoke de produção — duas vozes",
            "language": "pt-BR",
            "source": "upload",
        },
        expect=(200, 201),
    )
    if created["status"] == "deduplicated":
        _step(f"áudio já enviado antes: gravação {created['recording_id']}")
        return created["recording_id"]
    size = created["part_size"]
    # Um upload retomado (mesmo sha256, ainda in_progress) só traz URL das partes que faltam.
    parts = [{"part_number": p["part_number"], "etag": p["etag"]} for p in created["parts_received"]]
    for part in created["parts"]:
        number = part["part_number"]
        chunk = data[(number - 1) * size : number * size]
        status, headers, body = api.raw(part["method"], part["url"], chunk, part.get("headers") or {})
        if status != 200:  # noqa: PLR2004
            _fail(f"PUT parte {number} → {status}: {body[:200]!r}")
        parts.append({"part_number": number, "etag": headers["ETag"]})
    parts.sort(key=lambda p: p["part_number"])
    recording = api.json("POST", f"/api/v1/uploads/{created['id']}/complete", {"parts": parts}, expect=(200, 201))
    recording_id = recording.get("id") or recording.get("recording_id")
    _step(f"upload concluído: {len(parts)} parte(s), gravação {recording_id}")
    return recording_id


def _transcript_of(api: Api, recording_id: str, timeout_s: int) -> dict[str, Any]:
    def done() -> dict[str, Any] | None:
        recording = api.json("GET", f"/api/v1/recordings/{recording_id}")
        if recording["status"] == "failed":
            _fail(f"transcrição falhou: {recording['job'].get('error')}")
        if recording["status"] == "transcribed":
            return recording
        return None

    _step(f"esperando a transcrição na GPU (até {timeout_s} s; o primeiro job baixa os modelos)")
    started = time.monotonic()
    recording = _wait("a transcrição", done, timeout_s)
    transcript = api.json("GET", f"/api/v1/transcripts/{recording['transcript_id']}")
    speakers = [s for s in transcript["speakers"] if s.get("talk_ms", 0) > 0]
    _step(
        f"transcrição em {time.monotonic() - started:.0f} s: {len(transcript['segments'])} segmentos, "
        f"{len(speakers)} locutores, engine {transcript['engine']}"
    )
    if len(speakers) < 2:  # noqa: PLR2004
        _fail("a diarização não separou os 2 locutores do diálogo")
    for segment in transcript["segments"][:3]:
        _step(f"  [{segment['speaker_id']}] {segment['text']}")
    return transcript


def _summarize(api: Api, transcript_id: str, provider_id: str, timeout_s: int) -> None:
    templates = api.json("GET", "/api/v1/summary-templates")["items"]
    template = next((t for t in templates if t.get("is_default")), templates[0])
    summary = api.json(
        "POST",
        f"/api/v1/transcripts/{transcript_id}/summaries",
        {"template_id": template["id"], "provider_id": provider_id},
        expect=(202,),
    )

    def done() -> dict[str, Any] | None:
        current = api.json("GET", f"/api/v1/summaries/{summary['id']}")
        if current["status"] == "failed":
            _fail(f"resumo falhou: {current.get('error')}")
        return current if current["status"] == "done" else None

    result = _wait("o resumo", done, timeout_s)
    first = next((line for line in result["content_md"].splitlines() if line.strip()), "")
    _step(f"resumo '{template['name']}' pelo {result['model']}: {first[:100]}")


def main() -> int:
    """Roda o smoke e devolve o código de saída."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default="https://192.168.15.199:8443")
    parser.add_argument("--ca", help="CA raiz do Caddy do eclume (padrão: as CAs do sistema)")
    parser.add_argument("--email", default="admin@example.com")
    parser.add_argument("--audio", type=Path, default=FIXTURE)
    parser.add_argument("--timeout", type=int, default=1200, help="espera máxima da transcrição, em segundos")
    args = parser.parse_args()
    password = os.environ.get("ECLUME_SMOKE_PASSWORD") or sys.stdin.readline().strip()
    if not password:
        _fail("informe a senha pelo stdin ou por ECLUME_SMOKE_PASSWORD")

    api = Api(args.url, args.ca)
    _public_checks(api)
    api.json("POST", "/api/v1/auth/login", {"email": args.email, "password": password}, expect=(200, 204))
    me = api.json("GET", "/api/v1/me")
    _step(f"login ok: {me.get('email', args.email)}")
    provider_id = _ensure_provider(api)
    recording_id = _upload(api, args.audio)
    transcript = _transcript_of(api, recording_id, args.timeout)
    _summarize(api, transcript["id"], provider_id, 600)
    print("OK")  # noqa: T201
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
