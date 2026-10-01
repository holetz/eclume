"""Smoke do stack de produção do eclume, pela API pública, só com a biblioteca padrão.

Prova o caminho inteiro: health, SPA, `/downloads/`, o cadastro aberto com o aviso, a sessão de
admin (provider `claude-cli`), a sessão de usuário (upload multipart de um áudio, transcrição
diarizada na GPU e um resumo gerado pelo `claude -p` do host) e a gravação centrada no resumo
(holetz/eclume#34): edição à mão, chat de ajuste que lê a transcrição, volta à gerada, marcadores,
biblioteca pelo intervalo do dia e os quatro formatos de exportação.

    ssh holetz@192.168.15.199 cat /srv/eclume/secrets/admin-password \
      | python3 deploy/smoke_prod.py --ca eclume-root.crt

Com `--pipeline`, prova o processamento automático (holetz/eclume#33): retranscreve a gravação
(a de `--recording`, uma gravação real da biblioteca, ou a do áudio de fixture) e espera as seis
etapas do pipeline — recebido, pré-processamento, transcrição, campos, tipo de agenda e resumo —
todas `done`.

A senha vem do stdin (ou de `ECLUME_SMOKE_PASSWORD`) e serve às duas contas com o mesmo e-mail: a
de admin e a de usuário, que a migration 008 separou com o mesmo hash. Depois de um
`admin set-password`, a senha do admin vai em `ECLUME_SMOKE_ADMIN_PASSWORD`. Um áudio já enviado
volta como `deduplicated`, e o smoke confere a transcrição que ele já tem. Runbook:
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
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable
    from email.message import Message

FIXTURE = Path(__file__).resolve().parent.parent / "worker-gpu" / "tests" / "fixtures" / "duas-vozes.ogg"


class Api:
    """Cliente mínimo: cookies das sessões e CSRF double-submit nos métodos mutáveis.

    As sessões de usuário e de admin convivem no mesmo pote de cookies: o de admin só viaja para
    `/api/v1/admin`, e cada área ecoa o próprio cookie de CSRF.
    """

    def __init__(self, base: str, ca: str | None) -> None:
        """Cliente para `base`, confiando em `ca` (ou nas CAs do sistema)."""
        self.base = base.rstrip("/")
        self.jar = http.cookiejar.CookieJar()
        context = ssl.create_default_context(cafile=ca)
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=context), urllib.request.HTTPCookieProcessor(self.jar)
        )

    def _csrf(self, url: str) -> str | None:
        name = "eclume_admin_csrf" if "/api/v1/admin/" in url else "eclume_csrf"
        return next((c.value for c in self.jar if c.name == name), None)

    def raw(
        self, method: str, url: str, body: bytes | None = None, headers: dict[str, str] | None = None
    ) -> tuple[int, Message, bytes]:
        """Requisição crua: status, headers (sem caixa: o Caddy manda `Etag`) e corpo, sem lançar em erro."""
        full = url if url.startswith("http") else self.base + url
        request = urllib.request.Request(full, data=body, method=method, headers=headers or {})  # noqa: S310 — URL do próprio stack
        csrf = self._csrf(full)
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
        if "immutable" in headers.get("Cache-Control", ""):
            _fail(f"{path} saiu com cache longo: {headers.get('Cache-Control')}")
    # Chunk de um deploy anterior: 404 sem cache longo, nunca o index.html guardado por um ano.
    status, headers, _ = api.raw("GET", "/assets/nao-existe-smoke.js")
    if status != 404 or "immutable" in headers.get("Cache-Control", ""):  # noqa: PLR2004
        _fail(f"/assets ausente → {status} {headers.get('Cache-Control')}")
    status, headers, _ = api.raw("GET", "/downloads/latest.json")
    if status != 200 or "json" not in headers.get("Content-Type", ""):  # noqa: PLR2004
        _fail(f"/downloads/latest.json → {status} {headers.get('Content-Type')}")
    signup = api.json("GET", "/api/v1/auth/signup")
    if not signup["open"] or not signup["notice"]["version"]:
        _fail(f"cadastro fechado ou sem o aviso: {signup}")
    _step(
        f"health, SPA, asset ausente 404, /downloads/latest.json e cadastro aberto (aviso v{signup['notice']['version']}) ok"
    )


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
    _step(f"provider claude-cli cadastrado, usado para: {', '.join(created['used_for']) or 'nada'}")
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
            _fail(f"resumo falhou: {current.get('error')}")
        return current if current["status"] == "done" else None

    result = _wait("o resumo", done, timeout_s)
    first = next((line for line in result["content_md"].splitlines() if line.strip()), "")
    _step(f"resumo '{agenda_type['name']}' pelo {result['model']}: {first[:100]}")


EXPORTS = {
    "txt": "text/plain",
    "srt": "application/x-subrip",
    "md": "text/markdown",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


def _edit_and_chat(api: Api, recording_id: str, timeout_s: int) -> None:
    """Edição à mão (versão `manual`), chat que lê a transcrição (versão `chat`) e volta à gerada."""
    url = f"/api/v1/recordings/{recording_id}/summary"
    current = api.json("GET", url)["current"]
    edited = api.json(
        "PUT",
        url,
        {"content_md": current["content_md"] + "\n\n_Revisado no smoke._", "base_version": current["version"]},
    )
    if edited["origin"] != "manual":
        _fail(f"a edição não virou versão manual: {edited}")
    _step(f"resumo editado à mão: versão {edited['version']} ({edited['origin']})")

    request = "Diga quem fala primeiro na reunião e acrescente isso no início do resumo."
    exchange = api.json("POST", f"{url}/chat", {"message": request}, expect=(202,))
    started = time.monotonic()

    def answered() -> dict[str, Any] | None:
        reply = api.json("GET", f"/api/v1/summary-chat-messages/{exchange['reply']['id']}")
        if reply["status"] == "failed":
            _fail(f"o chat falhou: {reply['error']}")
        return reply if reply["status"] == "done" else None

    reply = _wait("a resposta do chat", answered, timeout_s, interval_s=2)
    if not reply["reads"]:
        _fail(f"o chat respondeu sem ler a transcrição: {reply['content']}")
    if reply["summary_id"] is None:
        _fail(f"o chat não criou a versão chat: {reply['error'] or reply['content']}")
    state = api.json("GET", url)
    if state["current"]["origin"] != "chat":
        _fail(f"a versão atual não é a do chat: {state['current']['origin']}")
    _step(f"chat em {time.monotonic() - started:.0f} s, leituras {reply['reads']}: {reply['content'][:100]}")

    reverted = api.json("POST", f"{url}/revert", expect=(201,))
    if reverted["restored_from_id"] != state["generated"]["id"]:
        _fail(f"voltar à gerada não restaurou a gerada: {reverted}")
    _step(f"de volta à gerada: versão {reverted['version']} ({api.json('GET', url)['version_count']} guardadas)")


def _markers_and_library(api: Api, recording: dict[str, Any]) -> None:
    """Dois marcadores e a gravação na biblioteca do dia dela, só reuniões."""
    markers = [{"client_id": str(uuid.uuid4()), "at_ms": at_ms, "note": "smoke"} for at_ms in (1000, 3000)]
    page = api.json(
        "POST", f"/api/v1/recordings/{recording['id']}/markers", {"markers": markers, "device_name": "smoke"}
    )
    if len(page["items"]) < 2:  # noqa: PLR2004
        _fail(f"os marcadores não foram gravados: {page}")
    count = api.json("GET", f"/api/v1/recordings/{recording['id']}")["marker_count"]
    _step(f"marcadores gravados: {count} na gravação")

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
        _fail(f"a gravação não apareceu na biblioteca de {day.date()}")
    _step(f"biblioteca de {day.date()} com kind=meeting: {len(listed)} gravação(ões)")


def _exports(api: Api, recording_id: str) -> None:
    """Os quatro formatos, com o Content-Type certo; o DOCX abre como zip (`PK`)."""
    sizes = []
    for export_format, media in EXPORTS.items():
        status, headers, body = api.raw("GET", f"/api/v1/recordings/{recording_id}/export?format={export_format}")
        if status != 200 or not (headers.get("Content-Type") or "").startswith(media):  # noqa: PLR2004
            _fail(f"export {export_format} → {status} {headers.get('Content-Type')}: {body[:200]!r}")
        if export_format == "docx" and body[:2] != b"PK":
            _fail("o DOCX não é um arquivo Office (zip)")
        sizes.append(f"{export_format} {len(body)} B")
    _step(f"exportação: {', '.join(sizes)}")


PIPELINE = ("received", "preprocessing", "transcription", "fields", "agenda_type", "summary")


def _pipeline(api: Api, recording_id: str, timeout_s: int) -> None:
    """Retranscreve a gravação e espera as seis etapas `done`; qualquer outra saída final falha."""
    retried = api.json("POST", f"/api/v1/recordings/{recording_id}/retranscribe", expect=(202,))
    _step(f"retranscrição da gravação {recording_id} na fila (etapas: {_states(retried)})")

    def finished() -> dict[str, Any] | None:
        recording = api.json("GET", f"/api/v1/recordings/{recording_id}")
        states = {step["step"]: step["state"] for step in recording["pipeline"]}
        if any(state in {"failed", "skipped"} for state in states.values()):
            _fail(f"etapa que não terminou feita: {json.dumps(recording['pipeline'], ensure_ascii=False)}")
        return recording if all(states[step] == "done" for step in PIPELINE) else None

    started = time.monotonic()
    recording = _wait("as seis etapas do pipeline", finished, timeout_s)
    _step(f"pipeline completo em {time.monotonic() - started:.0f} s:")
    for step in recording["pipeline"]:
        _step(f"  {step['step']:<14} {step['state']:<5} {step['duration_ms']} ms")
    fields = api.json("GET", f"/api/v1/recordings/{recording_id}/fields")["items"]
    auto = [f"{item['field']['key']}={item['value']!r}" for item in fields if item["origin"] == "auto"]
    _step(f"campos automáticos: {', '.join(auto) or 'nenhum'}")
    agenda_type = recording["agenda_type"] or {}
    _step(f"tipo de agenda: {agenda_type.get('name')} ({agenda_type.get('origin')}); título: {recording['title']}")
    summaries = api.json("GET", f"/api/v1/transcripts/{recording['transcript_id']}/summaries")["items"]
    automatic = next(s for s in summaries if s["trigger"] == "automatic" and s["status"] == "done")
    first = next((line for line in (automatic["content_md"] or "").splitlines() if line.strip()), "")
    _step(f"resumo automático '{automatic['agenda_type']['name']}' pelo {automatic['model']}: {first[:100]}")


def _states(recording: dict[str, Any]) -> str:
    return ", ".join(f"{step['step']}={step['state']}" for step in recording["pipeline"])


def main() -> int:
    """Roda o smoke e devolve o código de saída."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default="https://192.168.15.199:8443")
    parser.add_argument("--ca", help="CA raiz do Caddy do eclume (padrão: as CAs do sistema)")
    parser.add_argument("--email", default="admin@example.com", help="e-mail das duas contas")
    parser.add_argument("--admin-email", help="e-mail da conta de admin (padrão: --email)")
    parser.add_argument("--audio", type=Path, default=FIXTURE)
    parser.add_argument("--timeout", type=int, default=1200, help="espera máxima da transcrição, em segundos")
    parser.add_argument("--pipeline", action="store_true", help="prova as seis etapas do processamento automático")
    parser.add_argument("--recording", help="com --pipeline: a gravação a retranscrever (padrão: a do áudio)")
    args = parser.parse_args()
    password = os.environ.get("ECLUME_SMOKE_PASSWORD") or sys.stdin.readline().strip()
    if not password:
        _fail("informe a senha pelo stdin ou por ECLUME_SMOKE_PASSWORD")

    api = Api(args.url, args.ca)
    _public_checks(api)
    admin_email = args.admin_email or args.email
    admin_password = os.environ.get("ECLUME_SMOKE_ADMIN_PASSWORD") or password
    api.json("POST", "/api/v1/admin/auth/login", {"email": admin_email, "password": admin_password}, expect=(204,))
    _step(f"sessão de admin ok: {api.json('GET', '/api/v1/admin/me')['email']}")
    provider_id = _ensure_provider(api)
    api.json("POST", "/api/v1/auth/login", {"email": args.email, "password": password}, expect=(200, 204))
    me = api.json("GET", "/api/v1/me")
    _step(f"sessão de usuário ok: {me['user']['email']} (aviso pendente: {me['notice_required']})")
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
