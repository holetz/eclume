# ruff: noqa: INP001  # script solto, rodado pelo workflow de release; mobile/ não é pacote Python
"""Monta o `movel.json` e o `SHA256SUMS` de um release do app móvel do eclume.

Lê a pasta do release (o APK assinado e o `INSTALACAO.md`) e grava nela:

- `movel.json` — o manifesto que a tela `/app-movel` da web (holetz/eclume#38) e o próprio app
  consomem: `versao`, `publicado_em`, `notas`, `apk {arquivo, url, tamanho, sha256}`,
  `min_android`, `certificado_sha256` e `instalacao`;
- `SHA256SUMS` — o hash de todo arquivo da pasta, conferido na publicação no host.

As URLs são caminhos absolutos no servidor (`/downloads/movel/<versão>/<arquivo>`), onde
`deploy/publicar-movel.sh` põe os arquivos: servem a qualquer endereço do servidor, e o app as
resolve contra o servidor pareado.

Uso:
    python3 mobile/scripts/manifesto_movel.py --pasta dist --versao 0.1.0 \
        --certificado <sha256 do certificado de assinatura> [--notas "texto"]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

MANIFESTO = "movel.json"
SUMS = "SHA256SUMS"
INSTALACAO = "INSTALACAO.md"
BASE = "/downloads/movel"
MIN_ANDROID = "8.0"
VERSAO = re.compile(r"^\d+\.\d+\.\d+$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def sha256(caminho: Path) -> str:
    """SHA-256 do arquivo, em hex minúsculo, lido em blocos."""
    h = hashlib.sha256()
    with caminho.open("rb") as arquivo:
        for bloco in iter(lambda: arquivo.read(1 << 20), b""):
            h.update(bloco)
    return h.hexdigest()


def normalizar_certificado(texto: str) -> str:
    """O SHA-256 do certificado como o `apksigner` imprime (com ou sem `:`), em hex minúsculo."""
    valor = texto.strip().replace(":", "").lower()
    if not SHA256.match(valor):
        msg = f"certificado inválido: {texto!r} (esperado o SHA-256 em 64 hexadecimais)"
        raise ValueError(msg)
    return valor


def montar(pasta: Path, versao: str, certificado: str, notas: str, agora: datetime) -> dict:
    """O manifesto da pasta: exatamente um APK, com o nome `eclume-<versão>.apk`."""
    if not VERSAO.match(versao):
        msg = f"versão inválida: {versao!r}"
        raise ValueError(msg)
    apks = sorted(pasta.glob("*.apk"))
    if len(apks) != 1:
        msg = f"esperava um APK em {pasta}, achei {len(apks)}"
        raise ValueError(msg)
    apk = apks[0]
    esperado = f"eclume-{versao}.apk"
    if apk.name != esperado:
        msg = f"o APK se chama {apk.name}, esperado {esperado}"
        raise ValueError(msg)
    if not (pasta / INSTALACAO).is_file():
        msg = f"falta {INSTALACAO} em {pasta}"
        raise ValueError(msg)
    return {
        "versao": versao,
        "publicado_em": agora.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "notas": notas,
        "apk": {
            "arquivo": apk.name,
            "url": f"{BASE}/{versao}/{apk.name}",
            "tamanho": apk.stat().st_size,
            "sha256": sha256(apk),
        },
        "min_android": MIN_ANDROID,
        "certificado_sha256": normalizar_certificado(certificado),
        "instalacao": f"{BASE}/{INSTALACAO}",
    }


def gravar(pasta: Path, manifesto: dict) -> None:
    """Grava o `movel.json` e o `SHA256SUMS` de todos os arquivos da pasta."""
    (pasta / MANIFESTO).write_text(json.dumps(manifesto, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    linhas = [f"{sha256(f)}  {f.name}" for f in sorted(pasta.iterdir()) if f.is_file() and f.name != SUMS]
    (pasta / SUMS).write_text("\n".join(linhas) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    """Monta e grava os manifestos; devolve o código de saída."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pasta", type=Path, required=True)
    parser.add_argument("--versao", required=True)
    parser.add_argument("--certificado", required=True)
    parser.add_argument("--notas", default="")
    args = parser.parse_args(argv)
    try:
        manifesto = montar(args.pasta, args.versao, args.certificado, args.notas, datetime.now(UTC))
    except ValueError as erro:
        sys.stderr.write(f"{erro}\n")
        return 1
    gravar(args.pasta, manifesto)
    sys.stdout.write(json.dumps(manifesto, ensure_ascii=False, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
