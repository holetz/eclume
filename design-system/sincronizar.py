# ruff: noqa: INP001  # script solto: design-system/ não é pacote Python
"""Gera as três cópias do Design System a partir de `design-system/styles.css`.

Escreve `web/src/styles/eclume.css`, `desktop/ui/eclume.css` e `mobile/ui/src/styles/eclume.css` com
um cabeçalho fixo e sem a linha do `@import` do Google Fonts (as fontes vêm do `fonts.css` de cada
cliente). Sem data no cabeçalho: a saída é determinística. Com `--check`, só compara e falha quando
alguma cópia diverge da fonte.

Uso: `uv run python design-system/sincronizar.py [--check]`
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
FONTE = RAIZ / "design-system" / "styles.css"
COPIAS = (
    RAIZ / "web" / "src" / "styles" / "eclume.css",
    RAIZ / "desktop" / "ui" / "eclume.css",
    RAIZ / "mobile" / "ui" / "src" / "styles" / "eclume.css",
)
CABECALHO = (
    "/* Gerado de design-system/styles.css por design-system/sincronizar.py, sem o @import do Google Fonts.\n"
    "   Não edite: ajuste de produto vai em app.css. */\n"
)


def gerar(fonte: str) -> str:
    """O conteúdo de uma cópia: o cabeçalho e a fonte sem a linha do Google Fonts, em LF."""
    linhas = fonte.replace("\r\n", "\n").splitlines(keepends=True)
    return CABECALHO + "".join(linha for linha in linhas if "fonts.googleapis.com" not in linha)


def divergentes(raiz: Path = RAIZ) -> list[Path]:
    """As cópias que não batem com a fonte."""
    esperado = gerar((raiz / FONTE.relative_to(RAIZ)).read_text(encoding="utf-8"))
    copias = [raiz / c.relative_to(RAIZ) for c in COPIAS]
    return [c for c in copias if not c.exists() or c.read_bytes().decode("utf-8").replace("\r\n", "\n") != esperado]


def main(argv: list[str] | None = None) -> int:
    """Escreve as cópias, ou só confere com `--check`."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="só compara; falha se alguma cópia divergir")
    args = parser.parse_args(argv)
    if args.check:
        fora = divergentes()
        for copia in fora:
            print(f"diverge da fonte: {copia.relative_to(RAIZ)}", file=sys.stderr)  # noqa: T201
        if fora:
            print("rode: uv run python design-system/sincronizar.py", file=sys.stderr)  # noqa: T201
        return 1 if fora else 0
    conteudo = gerar(FONTE.read_text(encoding="utf-8"))
    for copia in COPIAS:
        copia.write_bytes(conteudo.encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
