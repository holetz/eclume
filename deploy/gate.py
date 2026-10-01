# ruff: noqa: INP001  # script solto, chamado pelos scripts de deploy e pelos workflows; deploy/ não é pacote
"""Lógica do gate de qualidade do eclume (status `eclume/gate` no commit), só com a stdlib.

Subcomandos, todos com a entrada no stdin:

- `decidir` — o status combinado do commit (`gh api repos/<repo>/commits/<sha>/status`); sai 0 só
  quando o `eclume/gate` mais recente está em `success` e, senão, diz o estado e sai 1;
- `descricao` — uma linha `<pilar> <código de saída>` por pilar executado (`--duracao <s>`,
  `--log <caminho>`); imprime o estado final (`success`, `failure` ou `error`) e, na linha seguinte,
  a descrição do status, com no máximo 140 caracteres;
- `alvos-do-push` — o stdin do hook de pre-push; imprime o SHA de cada atualização de
  `refs/heads/main`, ignorando a ref apagada.

Contrato: docs/standards/code/monorepo.md.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

CONTEXTO = "eclume/gate"
PILARES = ("python", "contracts", "web", "web-browser", "desktop", "mobile", "docs", "windows", "auditoria")
# Pilares que só o gate roda: a CI não tem o xwin nem a rede da auditoria a cada PR.
SO_NO_GATE = ("windows", "auditoria")
LIMITE_DESCRICAO = 140
ALVO = "refs/heads/main"
SHA_NULO = "0" * 40


def estado_do_gate(combinado: dict[str, Any]) -> str | None:
    """Estado do `eclume/gate` no status combinado (o mais recente por contexto), ou None."""
    for status in combinado.get("statuses") or []:
        if status.get("context") == CONTEXTO:
            return status.get("state")
    return None


def decidir(combinado: dict[str, Any]) -> tuple[bool, str]:
    """(liberado, mensagem) para publicar o commit do status combinado."""
    estado = estado_do_gate(combinado)
    if estado == "success":
        return True, f"{CONTEXTO} = success"
    if estado is None:
        return False, f"{CONTEXTO} ausente no commit (rode bash deploy/gate.sh)"
    return False, f"{CONTEXTO} = {estado}, não success"


def _duracao(segundos: int) -> str:
    minutos, seg = divmod(max(segundos, 0), 60)
    return f"{minutos}min{seg:02d}s" if minutos else f"{seg}s"


def descricao(resultados: dict[str, int], duracao_s: int, log: str) -> tuple[str, str]:
    """(estado, descrição) do status a partir do código de saída de cada pilar."""
    falharam = [p for p in PILARES if resultados.get(p, 0) != 0]
    faltam = [p for p in PILARES if p not in resultados]
    if falharam:
        estado, resumo = "failure", "falhou: " + ", ".join(falharam)
    elif faltam:
        estado, resumo = "error", "sem prova: " + ", ".join(faltam)
    else:
        estado, resumo = "success", f"{len(PILARES)} pilares verdes"
    texto = f"{resumo} · {_duracao(duracao_s)} · log {log}"
    if len(texto) > LIMITE_DESCRICAO:
        cauda = f" · {_duracao(duracao_s)}"
        texto = resumo[: LIMITE_DESCRICAO - len(cauda) - 1] + "…" + cauda
    return estado, texto


def ler_resultados(linhas: list[str]) -> dict[str, int]:
    """`<pilar> <código>` por linha → {pilar: código}; linha vazia é ignorada."""
    resultados: dict[str, int] = {}
    for linha in linhas:
        partes = linha.split()
        if not partes:
            continue
        if len(partes) != 2 or partes[0] not in PILARES or not partes[1].isdigit():  # noqa: PLR2004
            raise ValueError(f"linha de resultado inválida: {linha!r}")
        resultados[partes[0]] = int(partes[1])
    return resultados


def alvos_do_push(linhas: list[str]) -> list[str]:
    """SHAs empurrados para `refs/heads/main` (formato do stdin do pre-push), sem a ref apagada."""
    alvos = []
    for linha in linhas:
        partes = linha.split()
        if len(partes) != 4:  # noqa: PLR2004
            continue
        _ref_local, sha_local, ref_remota, _sha_remoto = partes
        if ref_remota == ALVO and sha_local != SHA_NULO:
            alvos.append(sha_local)
    return alvos


def main(argv: list[str] | None = None) -> int:
    """Ponto de entrada da linha de comando."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="comando", required=True)
    sub.add_parser("decidir")
    desc = sub.add_parser("descricao")
    desc.add_argument("--duracao", type=int, default=0)
    desc.add_argument("--log", default="")
    sub.add_parser("alvos-do-push")
    args = parser.parse_args(argv)
    # O Python da estação Windows escreveria no código de página do console.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    entrada = sys.stdin.read()

    if args.comando == "decidir":
        try:
            combinado = json.loads(entrada or "{}")
        except json.JSONDecodeError:
            combinado = {}
        liberado, mensagem = decidir(combinado)
        sys.stdout.write(mensagem + "\n")
        return 0 if liberado else 1
    if args.comando == "descricao":
        estado, texto = descricao(ler_resultados(entrada.splitlines()), args.duracao, args.log)
        sys.stdout.write(f"{estado}\n{texto}\n")
        return 0
    sys.stdout.writelines(f"{sha}\n" for sha in alvos_do_push(entrada.splitlines()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
