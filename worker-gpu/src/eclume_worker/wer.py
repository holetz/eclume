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


def edit_counts(reference: Sequence[str], hypothesis: Sequence[str]) -> EditCounts:
    """Levenshtein com as contagens de S, D e I do alinhamento de menor custo."""
    rows, cols = len(reference), len(hypothesis)
    cost = [[0] * (cols + 1) for _ in range(rows + 1)]
    for i in range(1, rows + 1):
        cost[i][0] = i
    for j in range(1, cols + 1):
        cost[0][j] = j
    for i in range(1, rows + 1):
        for j in range(1, cols + 1):
            diagonal = cost[i - 1][j - 1] + (reference[i - 1] != hypothesis[j - 1])
            cost[i][j] = min(diagonal, cost[i - 1][j] + 1, cost[i][j - 1] + 1)
    substitutions = deletions = insertions = 0
    i, j = rows, cols
    while i > 0 or j > 0:
        if i > 0 and j > 0 and cost[i][j] == cost[i - 1][j - 1] + (reference[i - 1] != hypothesis[j - 1]):
            substitutions += reference[i - 1] != hypothesis[j - 1]
            i, j = i - 1, j - 1
        elif i > 0 and cost[i][j] == cost[i - 1][j] + 1:
            deletions += 1
            i -= 1
        else:
            insertions += 1
            j -= 1
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
