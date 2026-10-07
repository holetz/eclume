# ruff: noqa: INP001  # script solto, chamado pelo deploy.sh; deploy/ não é pacote
"""Decisões testáveis do deploy de produção (`deploy/deploy.sh`), só com a stdlib.

Subcomandos:

- `env-diverge <hashes-do-host> <env-local>` — o host manda, por SSH, uma linha `CHAVE<TAB>sha256`
  por chave do `secrets/env.prod` (o valor nunca sai do host); diverge quando uma chave do host
  falta no env local ou tem outro valor. Chave nova só no local passa. Imprime as chaves
  divergentes e sai 1; sem divergência, sai 0.
- `env-hashes <env>` — as linhas `CHAVE<TAB>sha256` de um env, no formato que o host produz.
- `retidos <deploys.log> [N]` — os SHAs dos últimos N deploys distintos (`manter<TAB>sha`) e os
  dumps pré-deploy dos deploys fora da janela (`remover-dump<TAB>caminho`).
- `voltar <deploys.log> <sha-alvo> <migrations-do-banco> <migrations-do-alvo>` — se o
  `--voltar` ao SHA é permitido: o trio dele precisa estar retido, e o banco não pode ter
  migrations que o alvo não conhece, salvo um passo atrás (a regra expandir/contrair garante que o
  código do deploy anterior roda sobre o schema novo). Recusa aponta o dump pré-deploy.
- `topologia <compose.json>` — a topologia do compose do SHA (`docker compose config --format json`
  da árvore dele, então vale também para um `--voltar` a um compose anterior ao worker único e à
  borda com o SPA, holetz/eclume#151): `imagem<TAB>nome<TAB>serviço` por imagem `eclume-<nome>:prod`
  construída (o trio retido: `server`, `edge` ou o antigo `web`, `worker-gpu`), `app<TAB>serviço`
  por serviço que sobe antes da borda (todos menos a infraestrutura, o `caddy` e o `mdns`) e
  `problema<TAB>texto` por `memswap_limit` menor que o `mem_limit`.

`deploys.log` (TSV, uma linha por deploy, do mais antigo ao mais novo): data, SHA, flags, motivo,
migrations aplicadas (separadas por vírgula, ou `-`) e o dump pré-deploy (caminho, ou `-`).
Runbook: docs/project/deploy-producao.md.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

RETIDOS = 3
_CHAVE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
_VAZIO = "-"


@dataclass(frozen=True)
class Deploy:
    """Uma linha do `deploys.log`."""

    data: str
    sha: str
    flags: str
    motivo: str
    migrations: tuple[str, ...]
    dump: str | None


def ler_env(texto: str) -> dict[str, str]:
    """As chaves de um env (`CHAVE=valor`); a última ocorrência vence, como no `env_value` do deploy."""
    valores: dict[str, str] = {}
    for linha in texto.splitlines():
        achado = _CHAVE.match(linha)
        if achado:
            valores[achado.group(1)] = achado.group(2)
    return valores


def hash_valor(valor: str) -> str:
    """O hash de um valor, igual ao `printf '%s' "$v" | sha256sum` do host."""
    return hashlib.sha256(valor.encode()).hexdigest()


def env_hashes(texto: str) -> dict[str, str]:
    """`{chave: sha256(valor)}` de um env."""
    return {chave: hash_valor(valor) for chave, valor in ler_env(texto).items()}


def ler_hashes(texto: str) -> dict[str, str]:
    """As linhas `CHAVE<TAB>sha256` que o host produz; a última ocorrência vence."""
    hashes: dict[str, str] = {}
    for linha in texto.splitlines():
        if "\t" in linha:
            chave, valor = linha.split("\t", 1)
            hashes[chave.strip()] = valor.strip()
    return hashes


def env_diverge(host: dict[str, str], local: dict[str, str]) -> list[str]:
    """As chaves do host (por hash) que faltam no local ou mudaram; chave nova só no local passa."""
    return sorted(chave for chave, valor in host.items() if local.get(chave) != valor)


def ler_log(texto: str) -> list[Deploy]:
    """As linhas do `deploys.log`, na ordem; linha malformada é ignorada."""
    deploys = []
    for linha in texto.splitlines():
        campos = linha.split("\t")
        if len(campos) < 6 or not campos[1]:  # noqa: PLR2004 — as seis colunas do log
            continue
        data, sha, flags, motivo, migrations, dump = campos[:6]
        deploys.append(
            Deploy(
                data=data,
                sha=sha,
                flags=flags,
                motivo=motivo,
                migrations=tuple(m for m in migrations.split(",") if m and m != _VAZIO),
                dump=None if dump in {"", _VAZIO} else dump,
            )
        )
    return deploys


def janela(deploys: list[Deploy], n: int = RETIDOS) -> list[str]:
    """Os SHAs dos últimos `n` deploys distintos, do mais novo ao mais antigo."""
    vistos: list[str] = []
    for deploy in reversed(deploys):
        if deploy.sha not in vistos:
            vistos.append(deploy.sha)
        if len(vistos) == n:
            break
    return vistos


def retidos(deploys: list[Deploy], n: int = RETIDOS) -> tuple[list[str], list[str]]:
    """`(SHAs a manter, dumps a remover)`: os dumps dos deploys fora da janela saem."""
    manter = janela(deploys, n)
    remover = [d.dump for d in deploys if d.dump and d.sha not in manter]
    # Um dump citado também por um deploy da janela fica.
    citados = {d.dump for d in deploys if d.dump and d.sha in manter}
    return manter, [dump for dump in dict.fromkeys(remover) if dump not in citados]


@dataclass(frozen=True)
class Decisao:
    """O `--voltar` é permitido? Se não, por quê."""

    permitido: bool
    motivo: str


def voltar(deploys: list[Deploy], alvo: str, banco: set[str], conhecidas: set[str], n: int = RETIDOS) -> Decisao:
    """Decide o `--voltar` ao SHA `alvo` (veja o docstring do módulo)."""
    retido = janela(deploys, n)
    if alvo not in retido:
        return Decisao(
            permitido=False,
            motivo=f"o trio de {alvo[:12]} não está retido (só os últimos {n} deploys: {', '.join(s[:12] for s in retido)})",
        )
    desconhecidas = sorted(banco - conhecidas)
    if not desconhecidas:
        return Decisao(permitido=True, motivo="o banco só tem migrations que o alvo conhece")
    # Um passo atrás: o alvo é o deploy distinto imediatamente anterior ao atual.
    if len(retido) >= 2 and retido[1] == alvo:  # noqa: PLR2004 — o atual e o anterior
        return Decisao(
            permitido=True, motivo=f"um passo atrás; o schema novo é expandir/contrair ({', '.join(desconhecidas)})"
        )
    ultimo_do_alvo = max(i for i, d in enumerate(deploys) if d.sha == alvo)
    dump = next((d.dump for d in deploys[ultimo_do_alvo + 1 :] if d.dump), None)
    onde = f"; restaure o banco do dump {dump} (restaurar-backup.sh --banco)" if dump else ""
    return Decisao(
        permitido=False,
        motivo=f"mais de um passo atrás com migrations que o alvo não conhece: {', '.join(desconhecidas)}{onde}",
    )


INFRA = ("postgres", "redis", "minio")
# Sobem depois do resto, cada um com o próprio passo: a borda recriada e o anúncio depois do `publish-ca`.
POR_ULTIMO = ("caddy", "mdns")
_IMAGEM = re.compile(r"^eclume-([a-z0-9][a-z0-9-]*):prod$")
_BYTES = re.compile(r"^(\d+)([bkmg]?)b?$", re.IGNORECASE)
_FATOR = {"": 1, "b": 1, "k": 1024, "m": 1024**2, "g": 1024**3}


@dataclass(frozen=True)
class Topologia:
    """O que o deploy sobe e retém, lido do compose do SHA."""

    imagens: tuple[tuple[str, str], ...]
    app: tuple[str, ...]
    problemas: tuple[str, ...]


def _bytes(valor: object) -> int | None:
    """`mem_limit`/`memswap_limit` em bytes: o `config` dá o número; `256m` também passa."""
    if isinstance(valor, int):
        return valor
    achado = _BYTES.match(str(valor).strip())
    return int(achado.group(1)) * _FATOR[achado.group(2).lower()] if achado else None


def topologia(config: dict[str, object]) -> Topologia:
    """A topologia do compose resolvido (veja o docstring do módulo)."""
    servicos = {
        nome: servico
        for nome, servico in (config.get("services") or {}).items()  # type: ignore[union-attr]
        if isinstance(servico, dict) and not servico.get("profiles")
    }
    donos: dict[str, list[str]] = {}
    for nome, servico in servicos.items():
        achado = _IMAGEM.match(str(servico.get("image") or ""))
        if achado and servico.get("build"):
            donos.setdefault(achado.group(1), []).append(nome)
    # O serviço que constrói cada imagem: o de mesmo nome (server, worker-gpu) ou o único (caddy).
    imagens = tuple((imagem, imagem if imagem in nomes else min(nomes)) for imagem, nomes in sorted(donos.items()))
    app = tuple(nome for nome in sorted(servicos) if nome not in INFRA + POR_ULTIMO)
    problemas = []
    for nome in sorted(servicos):
        teto = _bytes(servicos[nome].get("mem_limit")) if servicos[nome].get("mem_limit") else None
        swap = _bytes(servicos[nome].get("memswap_limit")) if servicos[nome].get("memswap_limit") else None
        if teto and swap and swap < teto:
            problemas.append(
                f"{nome}: memswap_limit ({swap // 1024**2} MiB) menor que o mem_limit ({teto // 1024**2} MiB);"
                f" suba ECLUME_MEMSWAP_{nome.upper().replace('-', '_')} junto com o teto"
            )
    return Topologia(imagens=imagens, app=app, problemas=tuple(problemas))


def _ler(caminho: str) -> str:
    return Path(caminho).read_text(encoding="utf-8") if Path(caminho).exists() else ""


def _linhas(caminho: str) -> set[str]:
    return {linha.strip() for linha in _ler(caminho).splitlines() if linha.strip()}


def _imprimir_topologia(caminho: str) -> int:
    topo = topologia(json.loads(_ler(caminho) or "{}"))
    for imagem, servico in topo.imagens:
        sys.stdout.write(f"imagem\t{imagem}\t{servico}\n")
    for servico in topo.app:
        sys.stdout.write(f"app\t{servico}\n")
    for problema in topo.problemas:
        sys.stdout.write(f"problema\t{problema}\n")
    return 0


def main(argv: list[str] | None = None) -> int:
    """Ponto de entrada; veja o docstring do módulo."""
    parser = argparse.ArgumentParser(prog="deploy_lib.py")
    sub = parser.add_subparsers(dest="comando", required=True)
    diverge = sub.add_parser("env-diverge")
    diverge.add_argument("host")
    diverge.add_argument("local")
    sub.add_parser("env-hashes").add_argument("env")
    ret = sub.add_parser("retidos")
    ret.add_argument("log")
    ret.add_argument("n", nargs="?", type=int, default=RETIDOS)
    volta = sub.add_parser("voltar")
    for nome in ("log", "alvo", "banco", "conhecidas"):
        volta.add_argument(nome)
    volta.add_argument("--retidos", type=int, default=RETIDOS)
    sub.add_parser("topologia").add_argument("compose")
    args = parser.parse_args(argv)

    if args.comando == "topologia":
        return _imprimir_topologia(args.compose)

    if args.comando == "env-hashes":
        for chave, valor in env_hashes(_ler(args.env)).items():
            sys.stdout.write(f"{chave}\t{valor}\n")
        return 0
    if args.comando == "env-diverge":
        chaves = env_diverge(ler_hashes(_ler(args.host)), env_hashes(_ler(args.local)))
        for chave in chaves:
            sys.stdout.write(f"{chave}\n")
        return 1 if chaves else 0
    if args.comando == "retidos":
        manter, remover = retidos(ler_log(_ler(args.log)), args.n)
        for sha in manter:
            sys.stdout.write(f"manter\t{sha}\n")
        for dump in remover:
            sys.stdout.write(f"remover-dump\t{dump}\n")
        return 0
    decisao = voltar(ler_log(_ler(args.log)), args.alvo, _linhas(args.banco), _linhas(args.conhecidas), args.retidos)
    sys.stdout.write(decisao.motivo + "\n")
    return 0 if decisao.permitido else 1


if __name__ == "__main__":
    sys.exit(main())
