"""WER and CER for Brazilian Portuguese, with its own edit distance.

Normalization (the same for reference and hypothesis): NFC, lowercase, and all punctuation becomes
a space, except the hyphen between letters ("guarda-chuva" is one word) and the apostrophe between
letters. Numbers and symbols are not expanded. Accents are preserved: "é" and "e" are different
words in Portuguese, and losing the accent is an ASR error. In the CER, the space between words
counts as one character.
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
    """Counts of a comparison: substitutions, deletions and insertions over `reference_len`."""

    substitutions: int
    deletions: int
    insertions: int
    reference_len: int

    @property
    def errors(self) -> int:
        """Sum of substitutions, deletions and insertions."""
        return self.substitutions + self.deletions + self.insertions

    @property
    def rate(self) -> float | None:
        """Error rate; `None` with an empty reference and a non-empty hypothesis."""
        if self.reference_len == 0:
            return None if self.errors else 0.0
        return self.errors / self.reference_len


def normalize(text: str) -> str:
    """Normalized text: lowercase words separated by a single space."""
    text = unicodedata.normalize("NFC", text).lower()
    text = _JOIN_RE.sub(_INNER_JOINER, text)
    text = _PUNCT_RE.sub(" ", text).replace(_INNER_JOINER, "-")
    return " ".join(text.split())


def _cost_row(reference: Sequence[str], hypothesis: Sequence[str], *, reverse: bool) -> list[int]:
    """Last cost row of the reference against the hypothesis prefixes.

    With `reverse`, both are read back to front, so `row[k]` is the cost of the last `k` items of
    the hypothesis against the whole reference.
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
    """Levenshtein with the S, D and I counts of a minimum-cost alignment.

    Hirschberg's algorithm: memory linear in the hypothesis size and quadratic time. The reference
    is split in half; the hypothesis cut that minimizes `cost(left) + cost(right)` separates two
    independent subproblems, and the leaves add up to the optimal distance. On a tie the chosen
    alignment may differ from a full matrix's, but the total of errors is the same.
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
    """Per-word counts, after normalizing both texts."""
    return edit_counts(normalize(reference).split(), normalize(hypothesis).split())


def char_counts(reference: str, hypothesis: str) -> EditCounts:
    """Per-character counts, after normalizing both texts."""
    return edit_counts(list(normalize(reference)), list(normalize(hypothesis)))


def wer(reference: str, hypothesis: str) -> float | None:
    """Word error rate."""
    return word_counts(reference, hypothesis).rate


def cer(reference: str, hypothesis: str) -> float | None:
    """Character error rate."""
    return char_counts(reference, hypothesis).rate
