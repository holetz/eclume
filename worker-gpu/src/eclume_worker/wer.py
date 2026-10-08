"""WER e CER em português do Brasil, com distância de edição própria.

Normalização (a mesma para referência e hipótese): NFC, minúsculas, e toda pontuação vira espaço,
exceto o hífen entre letras ("guarda-chuva" é uma palavra) e o apóstrofo entre letras. Números
e símbolos não são expandidos. Os acentos são preservados: "é" e "e" são palavras diferentes em
português, e perder o acento é erro de ASR. No CER, o espaço entre palavras conta como um caractere.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Sequence

_INNER_JOINER = "\x00"
_JOIN_RE = re.compile(r"(?<=\w)[-'\u2019](?=\w)")
_PUNCT_RE = re.compile(r"[^\w\x00]+")


@dataclass(frozen=True)
class EditCounts:
    """Contagens de uma comparação: substituições, remoções e inserções sobre `reference_len`."""

    substitutions: int
    deletions: int
    insertions: int
    reference_len: int

    @property
    def errors(self) -> int:
        """Soma de substituições, remoções e inserções."""
        return self.substitutions + self.deletions + self.insertions

    @property
    def rate(self) -> float | None:
        """Taxa de erro; `None` com referência vazia e hipótese não vazia."""
        if self.reference_len == 0:
            return None if self.errors else 0.0
        return self.errors / self.reference_len


def normalize(text: str) -> str:
    """Texto normalizado: palavras em minúsculas separadas por um espaço."""
    text = unicodedata.normalize("NFC", text).lower()
    text = _JOIN_RE.sub(_INNER_JOINER, text)
    text = _PUNCT_RE.sub(" ", text).replace(_INNER_JOINER, "-")
    return " ".join(text.split())


def _cost_row(reference: Sequence[str], hypothesis: Sequence[str], *, reverse: bool) -> list[int]:
    """Última linha de custo da referência contra os prefixos da hipótese.

    Com `reverse`, ambas são lidas de trás para frente, então `row[k]` é o custo dos últimos `k`
    itens da hipótese contra a referência inteira.
    """
    hyp = hypothesis[::-1] if reverse else hypothesis
    ref = reference[::-1] if reverse else reference
    row = list(range(len(hyp) + 1))
    for item in ref:
        diagonal = row[0]
        row[0] += 1
        for j, other in enumerate(hyp, 1):
            above = row[j]
            row[j] = min(diagonal + (item != other), above + 1, row[j - 1] + 1)
            diagonal = above
    return row


def edit_counts(reference: Sequence[str], hypothesis: Sequence[str]) -> EditCounts:
    """Levenshtein com as contagens de S, D e I de um alinhamento de menor custo.

    Algoritmo de Hirschberg: memória linear no tamanho da hipótese e tempo quadrático. A referência
    é partida ao meio; o corte da hipótese que minimiza `custo(esq) + custo(dir)` separa dois
    subproblemas independentes, e as folhas somam a distância ótima. Num empate o alinhamento
    escolhido pode diferir do de uma matriz completa, mas o total de erros é o mesmo.
    """
    rows = len(reference)
    start = 0
    stop_ref, stop_hyp = rows, len(hypothesis)
    while start < stop_ref and start < stop_hyp and reference[start] == hypothesis[start]:
        start += 1
    while stop_ref > start and stop_hyp > start and reference[stop_ref - 1] == hypothesis[stop_hyp - 1]:
        stop_ref -= 1
        stop_hyp -= 1
    substitutions = deletions = insertions = 0
    pending = [(start, stop_ref, start, stop_hyp)]
    while pending:
        r0, r1, h0, h1 = pending.pop()
        height, width = r1 - r0, h1 - h0
        if height == 0:
            insertions += width
        elif width == 0:
            deletions += height
        elif height == 1:
            insertions += width - 1
            if reference[r0] not in hypothesis[h0:h1]:
                substitutions += 1
        else:
            mid = r0 + height // 2
            left = _cost_row(reference[r0:mid], hypothesis[h0:h1], reverse=False)
            right = _cost_row(reference[mid:r1], hypothesis[h0:h1], reverse=True)
            cut = min(range(width + 1), key=lambda k: left[k] + right[width - k])
            pending.append((r0, mid, h0, h0 + cut))
            pending.append((mid, r1, h0 + cut, h1))
    return EditCounts(substitutions, deletions, insertions, rows)


def word_counts(reference: str, hypothesis: str) -> EditCounts:
    """Contagens por palavra, depois de normalizar os dois textos."""
    return edit_counts(normalize(reference).split(), normalize(hypothesis).split())


def char_counts(reference: str, hypothesis: str) -> EditCounts:
    """Contagens por caractere, depois de normalizar os dois textos."""
    return edit_counts(list(normalize(reference)), list(normalize(hypothesis)))


def wer(reference: str, hypothesis: str) -> float | None:
    """Taxa de erro de palavras."""
    return word_counts(reference, hypothesis).rate


def cer(reference: str, hypothesis: str) -> float | None:
    """Taxa de erro de caracteres."""
    return char_counts(reference, hypothesis).rate
