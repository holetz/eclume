# ruff: noqa: INP001  # script solto da prova no Windows; desktop/ não é pacote Python
"""Confere pela API que uma nota por voz gravada pelo desktop chegou à biblioteca.

Entra com a conta de teste (`ECLUME_PROOF_EMAIL` e `ECLUME_PROOF_PASSWORD`; os nomes antigos
`ECLUME_PROVA_EMAIL` e `ECLUME_PROVA_SENHA` ainda valem) como o navegador faz
(`POST /api/v1/auth/login`, cookies `eclume_session` e `eclume_csrf`), lê a gravação e espera a
transcrição. Passa quando a gravação é uma nota (`kind: note`), veio do desktop na versão pedida
(`capture.client_version`) e chegou a `transcribed`.

Uso:
    python desktop/scripts/prova_nota.py --gravacao <id> --versao 0.2.0 \
        [--servidor https://192.168.15.199:8443] [--ca <pem>] [--espera 900]

Só biblioteca padrão: roda com qualquer Python 3.12 da estação.
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

PRONTA = "transcribed"
FALHOU = "failed"


class ProvaError(Exception):
    """A prova não passou; a mensagem diz por quê."""


def cliente(ca: str | None) -> urllib.request.OpenerDirector:
    """Um opener com cookies e a CA do eclume (a fixada pelo app, ou a do sistema)."""
    contexto = ssl.create_default_context(cafile=ca) if ca else ssl.create_default_context()
    return urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        urllib.request.HTTPSHandler(context=contexto),
    )


def pedir(opener: urllib.request.OpenerDirector, url: str, corpo: dict[str, Any] | None = None) -> dict[str, Any]:
    """GET (ou POST com JSON) e a resposta em JSON; um status de erro vira `ProvaError`."""
    dados = json.dumps(corpo).encode() if corpo is not None else None
    pedido = urllib.request.Request(url, data=dados, method="POST" if dados else "GET")  # noqa: S310
    pedido.add_header("Accept", "application/json")
    if dados:
        pedido.add_header("Content-Type", "application/json")
    try:
        with opener.open(pedido, timeout=30) as resposta:
            return json.loads(resposta.read() or b"{}")
    except urllib.error.HTTPError as erro:
        raise ProvaError(
            f"{pedido.method} {url} respondeu {erro.code}: {erro.read().decode(errors='replace')}"
        ) from erro


def conferir(gravacao: dict[str, Any], versao: str) -> list[str]:
    """O que não bate numa gravação (vazio quando é a nota do desktop na versão pedida)."""
    problemas = []
    if gravacao.get("kind") != "note":
        problemas.append(f"kind é {gravacao.get('kind')!r}, esperava 'note'")
    cliente_versao = (gravacao.get("capture") or {}).get("client_version")
    if cliente_versao != f"eclume-desktop/{versao}":
        problemas.append(f"capture.client_version é {cliente_versao!r}, esperava 'eclume-desktop/{versao}'")
    return problemas


def esperar_nota(
    opener: urllib.request.OpenerDirector, base: str, gravacao_id: str, versao: str, espera: int
) -> dict[str, Any]:
    """Lê a gravação até ela ficar pronta; a nota errada ou que não fica pronta é `ProvaError`."""
    prazo = time.monotonic() + espera
    while True:
        gravacao = pedir(opener, f"{base}/api/v1/recordings/{gravacao_id}")
        problemas = conferir(gravacao, versao)
        if problemas:
            raise ProvaError("; ".join(problemas))
        status = gravacao.get("status")
        if status == PRONTA:
            return gravacao
        if status == FALHOU or time.monotonic() > prazo:
            raise ProvaError(f"a gravação ficou em {status!r}")
        time.sleep(10)


def main() -> int:
    """Entra, espera a transcrição e confere a nota; 0 quando passa."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--servidor", default="https://192.168.15.199:8443")
    parser.add_argument("--gravacao", required=True, help="o id da gravação no servidor (remote_id da fila)")
    parser.add_argument("--versao", required=True, help="a versão do app que gravou, como 0.2.0")
    parser.add_argument("--ca", help="PEM da CA do servidor (o servidor-ca.pem que o app fixou)")
    parser.add_argument("--espera", type=int, default=900, help="segundos para a transcrição terminar")
    args = parser.parse_args()

    # ECLUME_PROVA_EMAIL/ECLUME_PROVA_SENHA are the deprecated pt-BR names, still read.
    email = os.environ.get("ECLUME_PROOF_EMAIL") or os.environ.get("ECLUME_PROVA_EMAIL")
    senha = os.environ.get("ECLUME_PROOF_PASSWORD") or os.environ.get("ECLUME_PROVA_SENHA")
    if not email or not senha:
        sys.stderr.write("set ECLUME_PROOF_EMAIL and ECLUME_PROOF_PASSWORD\n")
        return 2

    base = args.servidor.rstrip("/")
    opener = cliente(args.ca)
    try:
        pedir(opener, f"{base}/api/v1/auth/login", {"email": email, "password": senha})
        gravacao = esperar_nota(opener, base, args.gravacao, args.versao, args.espera)
    except (ProvaError, urllib.error.URLError) as erro:
        sys.stderr.write(f"prova da nota falhou: {erro}\n")
        return 1

    resumo = {
        "id": gravacao["id"],
        "title": gravacao.get("title"),
        "kind": gravacao["kind"],
        "status": gravacao["status"],
        "duration_ms": gravacao.get("duration_ms"),
        "client_version": gravacao["capture"]["client_version"],
    }
    sys.stdout.write(json.dumps(resumo, ensure_ascii=False, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
