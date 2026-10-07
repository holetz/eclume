# ruff: noqa: INP001, S101  # testes soltos dos scripts de deploy; deploy/ não é pacote Python
"""Testes do `deploy_lib.py`: divergência do env, retenção dos deploys e o `--voltar`."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import TYPE_CHECKING

import yaml

if TYPE_CHECKING:
    import pytest

_spec = importlib.util.spec_from_file_location("deploy_lib", Path(__file__).with_name("deploy_lib.py"))
assert _spec is not None
assert _spec.loader is not None
lib = importlib.util.module_from_spec(_spec)
# As dataclasses do módulo resolvem as anotações pelo `sys.modules`.
sys.modules["deploy_lib"] = lib
_spec.loader.exec_module(lib)

A, B, C, D = ("a" * 40, "b" * 40, "c" * 40, "d" * 40)


def linha(sha: str, migrations: str = "-", dump: str = "-", flags: str = "-") -> str:
    """Uma linha do `deploys.log`."""
    return f"2026-10-01T12:00:00Z\t{sha}\t{flags}\t-\t{migrations}\t{dump}"


def test_env_diverge_por_chave_e_nova_so_no_local_passa() -> None:
    """Chave do host faltando ou mudada diverge; chave nova só no local passa."""
    host = lib.env_hashes("ECLUME_PG_PASSWORD=x\nECLUME_SECRET_KEY=y\n")
    assert lib.env_diverge(host, lib.env_hashes("ECLUME_PG_PASSWORD=x\nECLUME_SECRET_KEY=y\nNOVA=z\n")) == []
    assert lib.env_diverge(host, lib.env_hashes("ECLUME_PG_PASSWORD=x\n")) == ["ECLUME_SECRET_KEY"]
    assert lib.env_diverge(host, lib.env_hashes("ECLUME_PG_PASSWORD=outro\nECLUME_SECRET_KEY=y\n")) == [
        "ECLUME_PG_PASSWORD"
    ]


def test_env_ignora_comentario_e_a_ultima_ocorrencia_vence() -> None:
    """Comentário e linha recuada não são chave; a última ocorrência vence."""
    assert lib.ler_env("# comentario\n\nA=1\nA=2\n  B=3\n") == {"A": "2"}


def test_hash_igual_ao_do_host() -> None:
    """O hash do valor é o do `printf '%s' | sha256sum` do host."""
    assert lib.hash_valor("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    hashes = lib.ler_hashes("A\t" + lib.hash_valor("v=1 2") + "\n")
    assert lib.env_diverge(hashes, lib.env_hashes("A=v=1 2\n")) == []


def test_cli_env_diverge(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """O subcomando imprime as chaves divergentes e sai 1."""
    host = tmp_path / "host"
    host.write_text("A\t" + lib.hash_valor("1") + "\nB\t" + lib.hash_valor("2") + "\n", encoding="utf-8")
    local = tmp_path / "local"
    local.write_text("A=1\nB=3\n", encoding="utf-8")
    assert lib.main(["env-diverge", str(host), str(local)]) == 1
    assert capsys.readouterr().out == "B\n"
    local.write_text("A=1\nB=2\n", encoding="utf-8")
    assert lib.main(["env-diverge", str(host), str(local)]) == 0


def test_retidos_mantem_os_ultimos_tres_distintos_e_solta_os_dumps_de_fora() -> None:
    """A janela são os três últimos SHAs distintos; os dumps de fora saem."""
    log = lib.ler_log(
        "\n".join(
            [
                linha(A, "020_x", "/srv/eclume/backups/pre-deploy/1.dump"),
                linha(B, "021_y", "/srv/eclume/backups/pre-deploy/2.dump"),
                linha(C),
                linha(C),
                linha(D, "022_z", "/srv/eclume/backups/pre-deploy/3.dump"),
                "linha quebrada",
            ]
        )
    )
    manter, remover = lib.retidos(log)
    assert manter == [D, C, B]
    assert remover == ["/srv/eclume/backups/pre-deploy/1.dump"]


def test_voltar_sem_migration_nova_e_permitido() -> None:
    """Sem migration que o alvo não conhece, o `--voltar` vale."""
    log = lib.ler_log("\n".join([linha(A), linha(B), linha(C)]))
    decisao = lib.voltar(log, A, banco={"001", "002"}, conhecidas={"001", "002"})
    assert decisao.permitido


def test_voltar_um_passo_com_migration_expandir_e_permitido() -> None:
    """Um passo atrás vale mesmo com migration nova (expandir/contrair)."""
    log = lib.ler_log("\n".join([linha(A), linha(B, "003", "/d/b.dump")]))
    decisao = lib.voltar(log, A, banco={"001", "002", "003"}, conhecidas={"001", "002"})
    assert decisao.permitido
    assert "003" in decisao.motivo


def test_voltar_dois_passos_com_migration_desconhecida_recusa_e_aponta_o_dump() -> None:
    """Mais de um passo com migration desconhecida recusa e aponta o dump."""
    log = lib.ler_log("\n".join([linha(A), linha(B, "003", "/d/b.dump"), linha(C, "004", "/d/c.dump")]))
    decisao = lib.voltar(log, A, banco={"001", "002", "003", "004"}, conhecidas={"001", "002"})
    assert not decisao.permitido
    assert "003, 004" in decisao.motivo
    assert "/d/b.dump" in decisao.motivo


def test_voltar_a_trio_nao_retido_recusa() -> None:
    """Trio fora da janela de retenção recusa."""
    log = lib.ler_log("\n".join([linha(A), linha(B), linha(C), linha(D)]))
    decisao = lib.voltar(log, A, banco=set(), conhecidas=set())
    assert not decisao.permitido
    assert "não está retido" in decisao.motivo


def test_cli_voltar(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """O subcomando sai 0 no permitido e 1 na recusa."""
    log = tmp_path / "deploys.log"
    log.write_text("\n".join([linha(A), linha(B, "003", "/d/b.dump"), linha(C, "004", "/d/c.dump")]) + "\n")
    banco, conhecidas = tmp_path / "banco", tmp_path / "alvo"
    banco.write_text("001\n003\n004\n")
    conhecidas.write_text("001\n003\n")
    assert lib.main(["voltar", str(log), B, str(banco), str(conhecidas)]) == 0
    assert "um passo atrás" in capsys.readouterr().out
    assert lib.main(["voltar", str(log), A, str(banco), str(conhecidas)]) == 1
    assert "/d/b.dump" in capsys.readouterr().out


def _servico(image: str, *, build: bool = False, **extra: object) -> dict[str, object]:
    servico: dict[str, object] = {"image": image, **extra}
    if build:
        servico["build"] = {"context": ".", "dockerfile": "Dockerfile"}
    return servico


# O `docker compose config --format json` de um compose anterior ao #151 (borda Caddy pura, `web`
# e os dois workers CPU), como o `--voltar` o lê da árvore do SHA.
COMPOSE_ANTERIOR = {
    "services": {
        "caddy": _servico("caddy:2.11@sha256:0c99", mem_limit="268435456"),
        "mdns": _servico("eclume-server:prod", build=True),
        "minio": _servico("pgsty/minio", mem_limit="1073741824"),
        "postgres": _servico("pgvector/pgvector:pg16"),
        "redis": _servico("redis:7-alpine", mem_limit="536870912"),
        "server": _servico("eclume-server:prod", build=True, mem_limit="1073741824"),
        "web": _servico("eclume-web:prod", build=True, mem_limit="134217728"),
        "worker-agents": _servico("eclume-server:prod", build=True, mem_limit="2147483648"),
        "worker-cpu": _servico("eclume-server:prod", build=True, mem_limit="1073741824"),
        "worker-gpu": _servico("eclume-worker-gpu:prod", build=True, mem_limit="8589934592"),
    }
}


def test_topologia_do_compose_atual_sobe_o_worker_unico_e_retem_a_borda() -> None:
    """O compose deste checkout: `edge` construída pelo `caddy`, sem `web` nem os dois workers."""
    compose = yaml.safe_load(Path(__file__).with_name("docker-compose.prod.yml").read_text(encoding="utf-8"))
    topo = lib.topologia(compose)
    assert topo.imagens == (("edge", "caddy"), ("server", "server"), ("worker-gpu", "worker-gpu"))
    assert topo.app == ("server", "worker", "worker-gpu")
    assert topo.problemas == ()


def test_topologia_do_compose_anterior_no_voltar() -> None:
    """Um `--voltar` a um SHA anterior ao #151 retém o trio com `web` e sobe os serviços dele."""
    topo = lib.topologia(COMPOSE_ANTERIOR)
    assert topo.imagens == (("server", "server"), ("web", "web"), ("worker-gpu", "worker-gpu"))
    assert topo.app == ("server", "web", "worker-agents", "worker-cpu", "worker-gpu")
    assert topo.problemas == ()


def test_topologia_ignora_os_one_shots_do_perfil_tools() -> None:
    """Serviço com perfil não sobe com o resto nem conta como imagem retida."""
    config = {
        "services": {
            "server": _servico("eclume-server:prod", build=True),
            "migrate": _servico("eclume-server:prod", build=True, profiles=["tools"]),
            "outro": _servico("eclume-outro:prod", build=True, profiles=["tools"]),
        }
    }
    topo = lib.topologia(config)
    assert topo.imagens == (("server", "server"),)
    assert topo.app == ("server",)


def test_topologia_recusa_memswap_menor_que_o_teto() -> None:
    """Teto subido sem o par de swap: o `up` falharia no meio do deploy."""
    config = {
        "services": {
            "worker": _servico("eclume-server:prod", build=True, mem_limit="4294967296", memswap_limit="3221225472"),
            "redis": _servico("redis", mem_limit="256m", memswap_limit="384m"),
        }
    }
    (problema,) = lib.topologia(config).problemas
    assert problema.startswith("worker: memswap_limit (3072 MiB) menor que o mem_limit (4096 MiB)")
    assert "ECLUME_MEMSWAP_WORKER" in problema


def test_cli_topologia(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """O subcomando lê o JSON do `config` e imprime imagens, serviços e problemas."""
    compose = tmp_path / "compose.json"
    compose.write_text(json.dumps(COMPOSE_ANTERIOR), encoding="utf-8")
    assert lib.main(["topologia", str(compose)]) == 0
    saida = capsys.readouterr().out.splitlines()
    assert "imagem\tweb\tweb" in saida
    assert "app\tworker-agents" in saida
    assert not [linha for linha in saida if linha.startswith(("app\tcaddy", "app\tmdns", "app\tpostgres"))]
