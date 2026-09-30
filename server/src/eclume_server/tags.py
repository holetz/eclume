"""Cadastro de tags do usuário: a lista fixa de que o agente escolhe e o que a mantém em ordem.

`recordings.tags` continua sendo o valor das gravações (a busca, a biblioteca e a exportação o
leem); o cadastro fica ao lado. Toda tag escrita pelo usuário entra no cadastro na grafia dele
(`adopt`), e renomear, mesclar e excluir mexem nas gravações e nas tags padrão dos tipos. O agente
casa variações (`canonical`) antes de propor uma tag nova. Contrato em
docs/standards/code/processamento-automatico.md.
"""

from __future__ import annotations

import re
import unicodedata
from typing import TYPE_CHECKING, Literal

from sqlalchemy import func, select, text

from eclume_server.db import tables as t

if TYPE_CHECKING:
    from uuid import UUID

    from sqlalchemy.ext.asyncio import AsyncConnection

    from eclume_server.serialize import Row

Mode = Literal["fixed", "auto"]
# O teto do cadastro para o agente: acima dele, o modo autogerenciado não cria mais tags.
MAX_CATALOG = 200
MAX_NEW_LIMIT = 5

# Terminações de plural do português, trocadas pela do singular antes de comparar.
_PLURALS = (("oes", "ao"), ("aes", "ao"), ("ais", "al"), ("eis", "el"), ("ns", "m"))
# Palavras curtas terminadas em "s" ("gas", "mes") não são tratadas como plural.
_MIN_PLURAL = 3


def _plain(name: str) -> str:
    """Minúsculas e sem acento, como o índice único do cadastro."""
    return unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower().strip()


def _singular(word: str) -> str:
    for plural, single in _PLURALS:
        if word.endswith(plural) and len(word) > len(plural) + 1:
            return word[: -len(plural)] + single
    return word[:-1] if word.endswith("s") and len(word) > _MIN_PLURAL else word


def canonical(name: str) -> str:
    """A forma de comparar duas tags: sem acento nem caixa, hífens e espaços unificados, no singular."""
    return " ".join(_singular(word) for word in re.split(r"[\s_\-]+", _plain(name)) if word)


async def catalog(conn: AsyncConnection, owner_id: UUID) -> list[Row]:
    """As tags cadastradas da conta, em ordem alfabética."""
    c = t.tags.c
    query = select(t.tags).where(c.owner_id == owner_id).order_by(func.lower(c.name), c.id)
    return list((await conn.execute(query)).mappings().all())


async def adopt(conn: AsyncConnection, owner_id: UUID, names: list[str], origin: str = "user") -> list[str]:
    """As tags na grafia do cadastro, cadastrando as que faltam; sem repetição, na ordem dada.

    Compara sem acento e sem caixa, como o índice único: "Cliente" vira a "cliente" já cadastrada.
    """
    known = {_plain(row["name"]): row["name"] for row in await catalog(conn, owner_id)}
    result: list[str] = []
    missing: list[str] = []
    for name in names:
        clean = name.strip()
        key = _plain(clean)
        if not clean:
            continue
        if key not in known:
            known[key] = clean
            missing.append(clean)
        result.append(known[key])
    if missing:
        await conn.execute(
            text(
                "INSERT INTO tags (owner_id, name, origin) "
                "SELECT :owner, n, :origin FROM unnest(CAST(:names AS text[])) AS n ON CONFLICT DO NOTHING"
            ),
            {"owner": owner_id, "origin": origin, "names": missing},
        )
    return list(dict.fromkeys(result))


def resolve(proposed: list[str] | None, names: list[str], *, allow_new: int, room: int) -> tuple[list[str], list[str]]:
    """As tags que o agente propôs, casadas com o cadastro: as que ficam e, entre elas, as novas.

    Uma variação de uma tag cadastrada (caixa, acento, plural) vira a cadastrada. As demais só ficam
    no modo autogerenciado (`allow_new`, o limite por gravação) e enquanto o cadastro tem espaço
    (`room`); no modo fixo, somem.
    """
    by_canonical: dict[str, str] = {}
    for name in names:
        by_canonical.setdefault(canonical(name), name)
    kept: list[str] = []
    new: list[str] = []
    for item in proposed or []:
        key = canonical(item)
        if not key:
            continue
        if key in by_canonical:
            kept.append(by_canonical[key])
        elif len(new) < min(allow_new, room):
            by_canonical[key] = item.strip()
            new.append(item.strip())
            kept.append(item.strip())
    return list(dict.fromkeys(kept)), new


async def prefs(conn: AsyncConnection, owner_id: UUID) -> tuple[Mode, int]:
    """O modo das tags da conta e o limite de tags novas por gravação (0 no modo fixo)."""
    mode, limit = (
        await conn.execute(select(t.users.c.tag_mode, t.users.c.tag_new_limit).where(t.users.c.id == owner_id))
    ).one()
    return mode, limit if mode == "auto" else 0


# Troca `:old` por `:new` (ou tira, com `:new` nulo) nas gravações, mantendo a ordem e sem repetir.
_REPLACE_IN_RECORDINGS = text(
    """
    UPDATE recordings SET
        tags = coalesce(
            (
                SELECT array_agg(x.tag ORDER BY x.pos)
                FROM (
                    SELECT CASE WHEN u.tag = :old THEN CAST(:new AS text) ELSE u.tag END AS tag, min(u.i) AS pos
                    FROM unnest(recordings.tags) WITH ORDINALITY AS u(tag, i)
                    GROUP BY 1
                ) x
                WHERE x.tag IS NOT NULL
            ),
            '{}'
        ),
        updated_at = now()
    WHERE :old = ANY(tags)
    RETURNING id
    """
)
_REPLACE_IN_TYPES = text(
    """
    UPDATE agenda_types SET
        default_tags = coalesce(
            (
                SELECT array_agg(x.tag ORDER BY x.pos)
                FROM (
                    SELECT CASE WHEN u.tag = :old THEN CAST(:new AS text) ELSE u.tag END AS tag, min(u.i) AS pos
                    FROM unnest(agenda_types.default_tags) WITH ORDINALITY AS u(tag, i)
                    GROUP BY 1
                ) x
                WHERE x.tag IS NOT NULL
            ),
            '{}'
        ),
        updated_at = now()
    WHERE :old = ANY(default_tags)
    """
)


async def replace_everywhere(conn: AsyncConnection, old: str, new: str | None) -> int:
    """Troca a tag `old` por `new` (ou a tira) nas gravações e nas tags padrão dos tipos da conta.

    Roda sob a RLS do dono. As transcrições das gravações tocadas sobem de `updated_at`: título e
    tags aparecem nelas, e o `?since=` dos clientes precisa ver a mudança. Devolve quantas gravações
    mudaram.
    """
    moved = list((await conn.execute(_REPLACE_IN_RECORDINGS, {"old": old, "new": new})).scalars())
    await conn.execute(_REPLACE_IN_TYPES, {"old": old, "new": new})
    if moved:
        await conn.execute(
            t.transcripts.update().where(t.transcripts.c.recording_id.in_(moved)).values(updated_at=func.now())
        )
    return len(moved)
