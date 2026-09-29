# ruff: noqa: INP001  # script solto, rodado à mão; desktop/ não é pacote Python
"""Gera os ícones da bandeja (`src-tauri/icons/tray-*.png`, 64 x 64 px) a partir da marca.

A marca é a do `icons/icon.svg`: o quadrado arredondado laranja com as cinco barras de onda
brancas. Cada estado do app muda só o que precisa para ser lido numa barra de 16 a 24 px:

- `tray-idle.png`: a marca;
- `tray-recording.png`: o quadrado na cor de gravação do DS (`--color-rec`), uma reunião;
- `tray-note.png`: a marca com o ponto de gravação, uma nota por voz;
- `tray-syncing.png`: a marca com o ponto de envio (`--color-accent`).

O ícone muda por estado, nunca pelo nível do áudio: no Linux cada troca grava um PNG e faz o
AppIndicator recarregar, e animar pelo nível seria escrita contínua (holetz/eclume#57).

    uv run --with pillow python desktop/scripts/icones_bandeja.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

SAIDA = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
TAMANHO = 64
ESCALA = 8  # desenha a 512 px e reduz: bordas suaves sem depender de um rasterizador de SVG

LARANJA = "#E89828"
BRANCO = "#FFFFFF"
GRAVACAO = "#B8432C"  # --color-rec do tema claro
ENVIO = "#6F5A44"  # --color-accent do tema claro

# As coordenadas do icon.svg (viewBox de 1024): o quadrado e as barras (x, y, altura).
QUADRADO = (64, 64, 960, 960)
RAIO_QUADRADO = 200
BARRAS = [(232, 432, 160), (352, 332, 360), (472, 232, 560), (592, 352, 320), (712, 452, 120)]
LARGURA_BARRA = 72


def _px(valor: float) -> int:
    return round(valor * TAMANHO * ESCALA / 1024)


def marca(fundo: str, ponto: str | None = None) -> Image.Image:
    """A marca num fundo; com `ponto`, o selo de estado no canto superior direito."""
    grande = TAMANHO * ESCALA
    imagem = Image.new("RGBA", (grande, grande), (0, 0, 0, 0))
    desenho = ImageDraw.Draw(imagem)
    desenho.rounded_rectangle([_px(v) for v in QUADRADO], radius=_px(RAIO_QUADRADO), fill=fundo)
    for x, y, altura in BARRAS:
        caixa = [_px(x), _px(y), _px(x + LARGURA_BARRA), _px(y + altura)]
        desenho.rounded_rectangle(caixa, radius=_px(LARGURA_BARRA / 2), fill=BRANCO)
    if ponto:
        # O selo com um aro branco, para destacar do laranja e do fundo escuro da barra.
        centro, raio, aro = _px(820), _px(200), _px(56)
        cx, cy = centro, _px(204)
        desenho.ellipse([cx - raio - aro, cy - raio - aro, cx + raio + aro, cy + raio + aro], fill=BRANCO)
        desenho.ellipse([cx - raio, cy - raio, cx + raio, cy + raio], fill=ponto)
    return imagem.resize((TAMANHO, TAMANHO), Image.Resampling.LANCZOS)


ICONES = {
    "tray-idle.png": (LARANJA, None),
    "tray-recording.png": (GRAVACAO, None),
    "tray-note.png": (LARANJA, GRAVACAO),
    "tray-syncing.png": (LARANJA, ENVIO),
}


def main() -> None:
    """Grava os quatro PNG em `src-tauri/icons/`."""
    for nome, (fundo, ponto) in ICONES.items():
        marca(fundo, ponto).save(SAIDA / nome, optimize=True)


if __name__ == "__main__":
    main()
