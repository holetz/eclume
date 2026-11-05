# ruff: noqa: INP001  # standalone script, run by hand; desktop/ is not a Python package
"""Generates the tray icons (`src-tauri/icons/tray-*.png`, 64 x 64 px) from the brand mark.

The mark is the one in `icons/icon.svg`: the rounded orange square with the five white wave
bars. Each app state changes only what it needs to be readable in a 16 to 24 px bar:

- `tray-idle.png`: the mark;
- `tray-recording.png`: the square in the DS recording color (`--color-rec`), a meeting;
- `tray-note.png`: the mark with the recording dot, a voice note;
- `tray-syncing.png`: the mark with the upload dot (`--color-accent`).

The icon changes by state, never by audio level: on Linux each change writes a PNG and makes the
AppIndicator reload, and animating by level would mean continuous writes (holetz/eclume#57).

    uv run --with pillow python desktop/scripts/tray_icons.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

OUTPUT = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
SIZE = 64
SCALE = 8  # draws at 512 px and scales down: smooth edges without depending on an SVG rasterizer

ORANGE = "#E89828"
WHITE = "#FFFFFF"
RECORDING = "#B8432C"  # --color-rec of the light theme
UPLOAD = "#6F5A44"  # --color-accent of the light theme

# The icon.svg coordinates (1024 viewBox): the square and the bars (x, y, height).
SQUARE = (64, 64, 960, 960)
SQUARE_RADIUS = 200
BARS = [(232, 432, 160), (352, 332, 360), (472, 232, 560), (592, 352, 320), (712, 452, 120)]
BAR_WIDTH = 72


def _px(value: float) -> int:
    return round(value * SIZE * SCALE / 1024)


def mark(background: str, dot: str | None = None) -> Image.Image:
    """The mark on a background; with `dot`, the state badge in the top right corner."""
    large = SIZE * SCALE
    image = Image.new("RGBA", (large, large), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle([_px(v) for v in SQUARE], radius=_px(SQUARE_RADIUS), fill=background)
    for x, y, height in BARS:
        box = [_px(x), _px(y), _px(x + BAR_WIDTH), _px(y + height)]
        draw.rounded_rectangle(box, radius=_px(BAR_WIDTH / 2), fill=WHITE)
    if dot:
        # The badge with a white ring, to stand out from the orange and from the bar's dark background.
        center, radius, ring = _px(820), _px(200), _px(56)
        cx, cy = center, _px(204)
        draw.ellipse([cx - radius - ring, cy - radius - ring, cx + radius + ring, cy + radius + ring], fill=WHITE)
        draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=dot)
    return image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)


ICONS = {
    "tray-idle.png": (ORANGE, None),
    "tray-recording.png": (RECORDING, None),
    "tray-note.png": (ORANGE, RECORDING),
    "tray-syncing.png": (ORANGE, UPLOAD),
}


def main() -> None:
    """Writes the four PNGs to `src-tauri/icons/`."""
    for name, (background, dot) in ICONS.items():
        mark(background, dot).save(OUTPUT / name, optimize=True)


if __name__ == "__main__":
    main()
