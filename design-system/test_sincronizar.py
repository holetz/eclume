# ruff: noqa: INP001, S101  # testes soltos do script: design-system/ não é pacote Python
"""As três cópias do `eclume.css` batem com `design-system/styles.css`."""

from __future__ import annotations

import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("sincronizar", Path(__file__).with_name("sincronizar.py"))
assert _spec is not None
assert _spec.loader is not None
sincronizar = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sincronizar)


def test_copias_batem_com_a_fonte() -> None:
    """Nenhuma cópia diverge: mudar o DS é mudar a fonte e rodar o sincronizar.py."""
    assert sincronizar.divergentes() == []


def test_gerar_tira_o_google_fonts_e_poe_o_cabecalho() -> None:
    """O cabeçalho é fixo, sem data, e a linha do Google Fonts sai."""
    fonte = "/* topo */\r\n@import url('https://fonts.googleapis.com/css2?x');\r\n:root { --a: 1; }\r\n"
    copia = sincronizar.gerar(fonte)
    assert copia == sincronizar.CABECALHO + "/* topo */\n:root { --a: 1; }\n"
    assert sincronizar.gerar(fonte) == copia


def test_check_acusa_copia_divergente(tmp_path: Path) -> None:
    """Uma cópia editada à mão aparece no `--check`."""
    (tmp_path / "design-system").mkdir()
    (tmp_path / "design-system" / "styles.css").write_text(":root { --a: 1; }\n", encoding="utf-8")
    copias = [tmp_path / c.relative_to(sincronizar.RAIZ) for c in sincronizar.COPIAS]
    for copia in copias:
        copia.parent.mkdir(parents=True, exist_ok=True)
        copia.write_text(sincronizar.gerar(":root { --a: 1; }\n"), encoding="utf-8")
    assert sincronizar.divergentes(tmp_path) == []
    copias[1].write_text("editado", encoding="utf-8")
    assert sincronizar.divergentes(tmp_path) == [copias[1]]
