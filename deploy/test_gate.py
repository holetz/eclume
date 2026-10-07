# ruff: noqa: INP001, S101  # testes soltos dos scripts de deploy; deploy/ não é pacote Python
"""Testes do `gate.py`: a decisão sobre o status `eclume/gate`, a descrição e os alvos do push."""

from __future__ import annotations

import importlib.util
import io
import json
import os
import subprocess
import tomllib
from pathlib import Path

import pytest
import yaml

_spec = importlib.util.spec_from_file_location("gate", Path(__file__).with_name("gate.py"))
assert _spec is not None
assert _spec.loader is not None
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)

SHA = "a" * 40
LOG = f"~/eclume-gate/logs/{SHA}.log"


def combinado(*statuses: tuple[str, str]) -> dict[str, object]:
    """Um status combinado do GitHub com um status por contexto."""
    return {"state": "pending", "statuses": [{"context": c, "state": s} for c, s in statuses]}


def rodar(
    argv: list[str], entrada: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> tuple[int, str]:
    """Roda o `gate.main` com a entrada no stdin e devolve (código, saída)."""
    monkeypatch.setattr("sys.stdin", io.StringIO(entrada))
    codigo = gate.main(argv)
    return codigo, capsys.readouterr().out


# --- decidir --------------------------------------------------------------------------------------


def test_decidir_libera_so_com_o_gate_em_success() -> None:
    """Só `success` libera; os outros estados recusam dizendo o estado."""
    assert gate.decidir(combinado(("eclume/gate", "success")))[0] is True
    for estado in ("pending", "failure", "error"):
        liberado, mensagem = gate.decidir(combinado(("eclume/gate", estado)))
        assert liberado is False
        assert estado in mensagem


def test_decidir_recusa_sem_o_gate_mesmo_com_outros_contextos_verdes() -> None:
    """Outro contexto verde, ou a dispensa, não substitui o gate."""
    liberado, mensagem = gate.decidir(combinado(("ci/outra", "success"), ("eclume/gate-dispensa", "failure")))
    assert liberado is False
    assert "ausente" in mensagem


def test_decidir_le_o_mais_recente_por_contexto_do_status_combinado() -> None:
    """O status combinado já traz um por contexto; a dispensa ao lado não atrapalha."""
    assert gate.decidir(combinado(("eclume/gate-dispensa", "failure"), ("eclume/gate", "success")))[0] is True


def test_decidir_pela_linha_de_comando(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    """Código de saída 0 só com o gate verde; entrada inválida vale como gate ausente."""
    codigo, saida = rodar(["decidir"], json.dumps(combinado(("eclume/gate", "success"))), monkeypatch, capsys)
    assert codigo == 0
    assert "success" in saida
    codigo, saida = rodar(["decidir"], "não é json", monkeypatch, capsys)
    assert codigo == 1
    assert "ausente" in saida


# --- descricao ------------------------------------------------------------------------------------


def todos(codigo: int = 0) -> dict[str, int]:
    """Todos os pilares com o mesmo código de saída."""
    return dict.fromkeys(gate.PILARES, codigo)


def test_descricao_success_so_com_todos_os_pilares_verdes() -> None:
    """`success` exige todos os pilares com saída 0."""
    estado, texto = gate.descricao(todos(), 125, LOG)
    assert estado == "success"
    assert texto == f"{len(gate.PILARES)} pilares verdes · 2min05s · log {LOG}"


def test_descricao_failure_nomeia_os_pilares_que_falharam_na_ordem() -> None:
    """A descrição nomeia os pilares que falharam, na ordem de `--lista`."""
    resultados = todos() | {"windows": 101, "python": 1}
    estado, texto = gate.descricao(resultados, 40, LOG)
    assert estado == "failure"
    assert texto.startswith("falhou: python, windows · 40s")


def test_descricao_error_quando_falta_pilar() -> None:
    """Pilar sem resultado é o gate sem prova: `error`."""
    resultados = todos()
    del resultados["mobile"]
    estado, texto = gate.descricao(resultados, 0, LOG)
    assert estado == "error"
    assert "sem prova: mobile" in texto


def test_descricao_cabe_em_140_caracteres() -> None:
    """O GitHub recusa descrição com mais de 140 caracteres."""
    estado, texto = gate.descricao(todos(1), 3600 * 2, "~/" + "x" * 200)
    assert estado == "failure"
    assert len(texto) <= gate.LIMITE_DESCRICAO
    assert texto.startswith("falhou: python, contracts")


def test_descricao_pela_linha_de_comando(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    """Estado na primeira linha e descrição na segunda."""
    entrada = "\n".join(f"{p} 0" for p in gate.PILARES) + "\n"
    codigo, saida = rodar(["descricao", "--duracao", "61", "--log", LOG], entrada, monkeypatch, capsys)
    assert codigo == 0
    assert saida.splitlines() == ["success", f"{len(gate.PILARES)} pilares verdes · 1min01s · log {LOG}"]


def test_resultado_invalido_e_recusado() -> None:
    """Pilar desconhecido na entrada é erro, não pilar verde."""
    with pytest.raises(ValueError, match="inválida"):
        gate.ler_resultados(["lumea 0"])


# --- alvos-do-push --------------------------------------------------------------------------------


def test_alvos_do_push_so_main_e_sem_ref_apagada() -> None:
    """Só atualizações de `refs/heads/main` disparam o gate; apagar a ref não dispara."""
    linhas = [
        f"refs/heads/main {SHA} refs/heads/main {'b' * 40}",
        f"refs/heads/plan/1-x {'c' * 40} refs/heads/plan/1-x {gate.SHA_NULO}",
        f"(delete) {gate.SHA_NULO} refs/heads/main {'d' * 40}",
        f"refs/heads/outro {'e' * 40} refs/heads/main {SHA}",
    ]
    assert gate.alvos_do_push(linhas) == [SHA, "e" * 40]


def test_alvos_do_push_pela_linha_de_comando(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """Um SHA por linha na saída."""
    codigo, saida = rodar(["alvos-do-push"], f"refs/heads/main {SHA} refs/heads/main {'b' * 40}\n", monkeypatch, capsys)
    assert codigo == 0
    assert saida.split() == [SHA]


# --- contrato com a CI ----------------------------------------------------------------------------

RAIZ = Path(__file__).resolve().parent.parent
WORKFLOWS = RAIZ / ".github" / "workflows"


def comandos(job: dict[str, object]) -> str:
    """Todo o `run:` de um job do workflow, numa string só."""
    passos = job.get("steps") or []
    assert isinstance(passos, list)
    return "\n".join(str(passo.get("run", "")) for passo in passos)


def test_cada_job_da_ci_chama_o_seu_pilar() -> None:
    """Cada job de pilar do `ci.yml` chama `deploy/pilares.sh <job>`; `windows` e `auditoria` são só do gate."""
    jobs = yaml.safe_load((WORKFLOWS / "ci.yml").read_text(encoding="utf-8"))["jobs"]
    pilares_da_ci = set(jobs) - {"mudancas"}
    assert pilares_da_ci == set(gate.PILARES) - set(gate.SO_NO_GATE)
    for nome in pilares_da_ci:
        assert f"bash deploy/pilares.sh {nome}" in comandos(jobs[nome]), nome
    for pilar in gate.SO_NO_GATE:
        assert f"pilares.sh {pilar}" not in (WORKFLOWS / "ci.yml").read_text(encoding="utf-8")


def test_android_e_pilar_so_do_gate() -> None:
    """O APK verificado (SDK do host, perto de 15 min) roda só no gate, depois dos outros."""
    assert gate.PILARES[-2] == "android"
    assert "android" in gate.SO_NO_GATE


def test_gpu_e2e_e_o_ultimo_pilar_e_so_do_gate() -> None:
    """A prova CUDA precisa da GPU do host: fica ao fim e fora da CI."""
    assert gate.PILARES[-1] == "gpu-e2e"
    assert "gpu-e2e" in gate.SO_NO_GATE


@pytest.mark.parametrize(
    "arquivo",
    [
        "worker-gpu/src/x.py",
        "engines/whisperx/a.py",
        "contracts/transcript.schema.json",
        "deploy/docker-compose.gpu-test.yml",
    ],
)
def test_gpu_e2e_exigido_por_gpu_engines_e_schema(arquivo: str) -> None:
    """Mudança em worker-gpu, engines, no schema da transcrição ou no compose liga o `gpu-e2e`."""
    assert "gpu-e2e" in gate.pilares_exigidos([arquivo])


def test_gpu_e2e_dispensado_por_mudanca_so_em_web() -> None:
    """Mudança só em `web/` não paga a GPU."""
    assert "gpu-e2e" not in gate.pilares_exigidos(["web/src/App.jsx"])


def test_gpu_e2e_75_e_sem_prova_inconclusivo_nunca_success_nem_failure() -> None:
    """Saída 75 do `gpu-e2e` (GPU ocupada) vira `error` "inconclusivo", distinto de falha."""
    estado, texto = gate.descricao(todos() | {"gpu-e2e": 75}, 10, LOG)
    assert estado == "error"
    assert "sem prova: gpu-e2e" in texto
    assert "inconclusivo" in texto
    assert "falhou" not in texto


def test_gpu_e2e_falha_real_e_failure() -> None:
    """Outra saída diferente de zero do `gpu-e2e` é falha, não inconclusivo."""
    estado, texto = gate.descricao(todos() | {"gpu-e2e": 1}, 10, LOG)
    assert estado == "failure"
    assert texto.startswith("falhou: gpu-e2e")


def test_75_em_outro_pilar_e_falha() -> None:
    """Só o `gpu-e2e` tem o código de inconclusivo."""
    estado, _ = gate.descricao(todos() | {"python": 75}, 10, LOG)
    assert estado == "failure"


def test_pilares_sh_lista_os_mesmos_pilares_do_gate() -> None:
    """O `--lista` do `pilares.sh` e o `gate.PILARES` andam juntos."""
    texto = (RAIZ / "deploy" / "pilares.sh").read_text(encoding="utf-8")
    assert f"PILARES=({' '.join(gate.PILARES)})" in texto


@pytest.mark.parametrize("arquivo", ["desktop-release.yml"])
def test_workflows_de_release_conferem_o_gate_antes_de_publicar(arquivo: str) -> None:
    """Quando vão publicar, os releases pelo Actions conferem o `eclume/gate` do commit, sem dispensa."""
    jobs = yaml.safe_load((WORKFLOWS / arquivo).read_text(encoding="utf-8"))["jobs"]
    conferem = [
        (nome, passo)
        for nome, job in jobs.items()
        for passo in job.get("steps") or []
        if "deploy/gate.py decidir" in str(passo.get("run", ""))
    ]
    assert len(conferem) == 1, arquivo
    nome, passo = conferem[0]
    assert "publicar == 'true'" in passo["if"]
    assert "--sem-gate" not in passo["run"]
    assert jobs[nome]["permissions"]["statuses"] == "read"


# --- pilares pelo diff ----------------------------------------------------------------------------


def _filtros_da_ci() -> dict[str, set[str]]:
    """Os filtros de caminho do job `mudancas` do `ci.yml`, com as âncoras YAML resolvidas."""
    jobs = yaml.safe_load((WORKFLOWS / "ci.yml").read_text(encoding="utf-8"))["jobs"]
    passos = jobs["mudancas"]["steps"]
    filtros = yaml.safe_load(next(p["with"]["filters"] for p in passos if p.get("id") == "filtro"))

    def achatar(itens: list[object]) -> set[str]:
        saida: set[str] = set()
        for item in itens:
            saida |= achatar(item) if isinstance(item, list) else {str(item)}
        return saida

    return {nome: achatar(itens) for nome, itens in filtros.items() if nome in gate.PILARES}


def test_mapa_de_caminhos_do_gate_e_o_dos_filtros_da_ci() -> None:
    """Os sete pilares da CI têm no gate exatamente os mesmos caminhos dos filtros do `ci.yml`."""
    da_ci = _filtros_da_ci()
    assert set(da_ci) == set(gate.PILARES) - set(gate.SO_NO_GATE)
    for pilar, globs in da_ci.items():
        assert set(gate.FILTROS[pilar]) == globs, pilar
    assert set(gate.FILTROS) == set(gate.PILARES)


def test_testpaths_do_pytest_estao_no_filtro_python() -> None:
    """Cada pasta do `testpaths` está sob um glob `<prefixo>/**` do filtro `python` da CI."""
    raiz = Path(__file__).resolve().parent.parent
    testpaths = tomllib.loads((raiz / "pyproject.toml").read_text(encoding="utf-8"))["tool"]["pytest"]["ini_options"][
        "testpaths"
    ]
    prefixos = {g.removesuffix("/**") for g in _filtros_da_ci()["python"] if g.endswith("/**")}
    descobertas = [pasta for pasta in testpaths if not any(pasta == p or pasta.startswith(f"{p}/") for p in prefixos)]
    assert not descobertas, f"pastas do testpaths fora do filtro python da CI: {descobertas}"


@pytest.mark.parametrize(
    ("arquivos", "esperado"),
    [
        (["web/src/App.jsx"], ["web", "web-browser"]),
        (["docs/index.md"], ["docs"]),
        (["README.md"], ["docs"]),
        (["server/eclume_server/app.py"], ["python"]),
        (["contracts/openapi.yaml"], ["python", "contracts", "web", "web-browser"]),
        (["desktop/src-tauri/src/main.rs"], ["desktop", "windows"]),
        (["mobile/src-tauri/src/lib.rs"], ["mobile", "android"]),
        (["desktop/crates/core/src/lib.rs"], ["desktop", "mobile", "windows", "android"]),
        (["web/src/lib/vocabulario.js"], ["web", "web-browser", "desktop", "mobile", "windows", "android"]),
        (["desktop/deny.toml"], ["desktop", "auditoria", "windows"]),
        ([".design/tokens.json", ".claude/settings.json"], []),
        ([], []),
    ],
)
def test_pilares_exigidos_pelo_mapa_de_caminhos(arquivos: list[str], esperado: list[str]) -> None:
    """Cada arquivo liga os pilares que o consomem, na ordem de `PILARES`; o resto não liga nenhum."""
    assert gate.pilares_exigidos(arquivos) == [p for p in gate.PILARES if p in esperado]


@pytest.mark.parametrize(
    "arquivo",
    [
        "deploy/staging.sh",
        "deploy/gate-host.sh",
        ".github/workflows/ci.yml",
        "uv.lock",
        "pyproject.toml",
        "web/package-lock.json",
        "desktop/Cargo.lock",
        "desktop/rust-toolchain.toml",
        ".nvmrc",
    ],
)
def test_deploy_lock_e_toolchain_rodam_todos(arquivo: str) -> None:
    """Mudança em `deploy/`, lock ou toolchain roda os onze pilares, junto com qualquer outro arquivo."""
    assert gate.pilares_exigidos([arquivo]) == list(gate.PILARES)
    assert gate.pilares_exigidos(["docs/index.md", arquivo]) == list(gate.PILARES)


def test_diff_desconhecido_roda_todos() -> None:
    """Sem diff (primeira execução, histórico reescrito), todos os pilares."""
    assert gate.pilares_exigidos(None) == list(gate.PILARES)


def test_pilares_pela_linha_de_comando(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    """`--stdin` lê os caminhos; `--todos` ignora o diff; `--desde` que o git não resolve roda todos."""
    codigo, saida = rodar(["pilares", "--stdin"], "docs/a.md\nweb/x.js\n", monkeypatch, capsys)
    assert (codigo, saida.split()) == (0, ["web", "web-browser", "docs"])
    _, saida = rodar(["pilares", "--stdin", "--todos"], "docs/a.md\n", monkeypatch, capsys)
    assert saida.split() == list(gate.PILARES)
    argv = ["pilares", "--desde", "f" * 40, "--sha", "e" * 40, "--repo", str(RAIZ)]
    _, saida = rodar(argv, "", monkeypatch, capsys)
    assert saida.split() == list(gate.PILARES)


def test_arquivos_alterados_le_o_diff_do_git(tmp_path: Path) -> None:
    """O diff `desde..ate` de um repositório de verdade vira a lista de caminhos."""
    ambiente = {
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@t",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@t",
        "PATH": os.environ["PATH"],
    }

    def git(*args: str) -> str:
        comando = ["git", "-C", str(tmp_path), *args]
        return subprocess.run(comando, check=True, capture_output=True, text=True, env=ambiente).stdout.strip()  # noqa: S603

    git("init", "-q")
    (tmp_path / "a.txt").write_text("1")
    git("add", ".")
    git("commit", "-qm", "um")
    base = git("rev-parse", "HEAD")
    (tmp_path / "web").mkdir()
    (tmp_path / "web" / "x.js").write_text("2")
    git("add", ".")
    git("commit", "-qm", "dois")
    assert gate.arquivos_alterados(base, "HEAD", str(tmp_path)) == ["web/x.js"]
    assert gate.arquivos_alterados("0" * 40, "HEAD", str(tmp_path)) is None


# --- descrição com pilares dispensados ------------------------------------------------------------


def test_descricao_com_dispensados_conta_so_os_exigidos() -> None:
    """Dispensado não é pilar faltando: os exigidos verdes dão `success` e a descrição diz o resto."""
    dispensados = tuple(p for p in gate.PILARES if p not in ("web", "docs"))
    estado, texto = gate.descricao({"web": 0, "docs": 0}, 90, LOG, dispensados, "b" * 40)
    assert estado == "success"
    assert texto.startswith("2 verdes (web, docs); 9 dispensados desde bbbbbbb · 1min30s")
    assert len(texto) <= gate.LIMITE_DESCRICAO


def test_descricao_com_dispensados_ainda_falha_e_exige_prova() -> None:
    """Pilar exigido que falhou ou não rodou não é coberto pela dispensa dos outros."""
    assert gate.descricao({"web": 1}, 1, LOG, ("python",), "b" * 40)[0] == "failure"
    estado, texto = gate.descricao({"web": 0}, 1, LOG, ("python",), "b" * 40)
    assert estado == "error"
    assert "sem prova: contracts" in texto


def test_descricao_sem_nenhum_pilar_exigido_e_success() -> None:
    """Um diff que não toca pilar nenhum (só `.design/`) é `success` e diz que nada era exigido."""
    estado, texto = gate.descricao({}, 0, LOG, gate.PILARES, "b" * 40)
    assert estado == "success"
    assert texto.startswith("nenhum pilar exigido; 11 dispensados")


def test_descricao_com_dispensados_pela_linha_de_comando(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`--dispensados` e `--desde` chegam à descrição."""
    dispensados = ",".join(p for p in gate.PILARES if p != "docs")
    argv = ["descricao", "--log", LOG, "--dispensados", dispensados, "--desde", "c" * 40]
    _, saida = rodar(argv, "docs 0\n", monkeypatch, capsys)
    assert saida.splitlines()[0] == "success"
    assert "10 dispensados desde ccccccc" in saida


def test_gate_sh_expoe_todos_e_o_host_decide_o_diff() -> None:
    """`--todos` vai do `gate.sh` ao host; o host decide os pilares pelo diff quando publica."""
    sh = (RAIZ / "deploy" / "gate.sh").read_text(encoding="utf-8")
    host = (RAIZ / "deploy" / "gate-host.sh").read_text(encoding="utf-8")
    assert "args+=(--todos)" in sh
    assert "--todos) FORCAR_TODOS=1" in host
    assert "gate.py pilares --stdin" in host
    assert "--dispensados" in host


# --- SHA superado, peso de CPU e poda -------------------------------------------------------------


def _host() -> str:
    return (RAIZ / "deploy" / "gate-host.sh").read_text(encoding="utf-8")


def test_so_o_pre_push_abandona_sha_superado() -> None:
    """O hook passa `--superavel` ao gate; o pedido à mão não, e o host só abandona com a flag."""
    hook = (RAIZ / ".githooks" / "pre-push").read_text(encoding="utf-8")
    sh = (RAIZ / "deploy" / "gate.sh").read_text(encoding="utf-8")
    host = _host()
    assert 'gate.sh" --fundo --superavel' in hook
    assert "args+=(--superavel)" in sh
    assert "--superavel) SUPERAVEL=1" in host
    # Só a ponta à frente do SHA o supera; sem ler a ponta ou com o push em curso, o gate roda.
    assert '"$SUPERAVEL" -eq 1' in host
    assert "== ahead" in host
    assert 'publicar error "superado por' in host
    # A checagem vem depois da trava, para valer para o SHA que esperou a vez.
    assert host.index("flock 9") < host.index('"$SUPERAVEL" -eq 1')


def test_todo_conteiner_do_gate_leva_cpu_shares() -> None:
    """Os pilares e os serviços de teste rodam com `--cpu-shares 256`, abaixo da produção."""
    host = _host()
    assert "CPU_SHARES=256" in host
    assert '--cpu-shares "$CPU_SHARES"' in host
    assert "cpu_shares: %s" in host
    assert host.count("docker run") == 1  # o único `docker run` do gate é o da linha acima
    assert '-f "$CPU_YML"' in host


def test_gate_poda_logs_imagens_antigas_e_arvores_abandonadas() -> None:
    """A poda apaga logs de mais de 30 dias e imagens de build de outro Rust, e nunca a imagem atual."""
    host = _host()
    assert "-name '*.log' -mtime +30 -delete" in host
    assert 'grep -vF ":$RUST"' in host
    assert "eclume-(gate|desktop-build|desktop-build-windows|mobile-build)" in host
    assert "-name 'src-*' -mtime +1" in host
