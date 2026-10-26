# ruff: noqa: INP001, T201, S310, S603, S607, S311 — standalone command-line script: prints, downloads from fixed URLs, calls ffmpeg and draws random numbers with no cryptographic purpose
"""Calibration of the voice identification threshold with real speech (holetz/eclume#15).

Measures how the speaker embeddings of pyannote `community-1` (the same ones the GPU worker writes
to `speaker_embeddings.json`) separate the same person from different people, across distinct
recordings.

The data are LibriVox readings in Portuguese (public domain), with each section's reader known
from the catalog. Each synthetic "meeting" joins 2 or 3 readers in alternating turns, each drawn
from a different section (a recording session), and goes through the same WhisperX
`DiarizationPipeline` that production uses, with `return_embeddings=True`. The diarized speaker is
matched to the reader by the overlap with the known turns.

```bash
python voice_calibration.py manifest --out manifest.json            # stdlib only, on any machine
python voice_calibration.py prepare manifest.json --work /work      # ffmpeg (worker image)
python voice_calibration.py embed --work /work --out embeddings.json  # GPU (worker image)
python voice_calibration.py analyze embeddings.json                 # stdlib only
```

No host (`docs/project/calibracao-voz.md`):

```bash
docker --context gpu-host run --rm --gpus all -v /srv/eclume/models:/models \
  -v /srv/eclume/secrets/hf_token:/run/secrets/hf_token:ro -v <dir>:/work \
  eclume-worker-gpu:prod python /work/voice_calibration.py embed --work /work --out /work/embeddings.json
```
"""

from __future__ import annotations

import argparse
import html
import itertools
import json
import math
import random
import re
import statistics
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

# LibriVox collections in Portuguese with several readers and several sections per reader.
COLLECTIONS = (
    "contos1_0911_librivox",
    "contos_2_0911_librivox",
    "contos_artur_azevedo_3_librivox",
    "contos_brasileiros_0807_librivox",
    "antologia_brasileira_v1_1708_librivox",
    "colecao_autoras_portugues_0912_librivox",
    "semana_arte_moderna_coletanea_2202_librivox",
    "antologia_de_discursos_em_portugues_1402_librivox",
    "fabulas1_esopo_1012_librivox",
    "fabula2_esopo_1104_librivox",
    "fabulas3_esopo_1107_librivox",
    "poemas_portugues_001_librivox",
    "perolas_e_diamantes_2007_librivox",
    "contos_para_velhos_0912_librivox",
    "contos_do_norte_1812_librivox",
    "noites_insonia1_1209_librivox",
    "noites_insomnia2_1405_librivox",
    "contos_fluminenses_1202_librivox",
    "historias_sem_data_2108_librivox",
    "varias_historias_2202_librivox",
    "papeis_avulsos_2102_librivox",
    "paginasrecolhidas_1805_librivox",
    "reliquias_de_casa_velha_2205_librivox",
    "contos_phantasticos_1904_librivox",
    "era_uma_vez_1904_librivox",
    "demonios_1709_librivox",
    "urupes_2202_librivox",
    "negrinha_2107_librivox",
    "contos_1802_librivox",
    "contos_barreto_vcf_librivox",
    "vida_vertiginosa_2110_librivox",
    "infelizes_historias_vividas_2103_librivox",
)
MIN_SECTION_S = 150  # a section must yield at least one long speech turn
MAX_SECTIONS_PER_READER = 4
SECTION_CUT_S = 300  # only the first 5 min of each section are used (enough for the turns)
TALK_TARGETS_S = (15, 30, 60, 120, 240)  # total speech of the reader in a meeting
TURN_S = (6.0, 25.0)  # duration of a turn
PURITY = 0.8  # fraction of the diarized speaker's speech that must come from a single reader
USER_AGENT = {"User-Agent": "eclume-voice-calibration/1.0"}


def _get(url: str, attempts: int = 4) -> str:
    request = urllib.request.Request(url, headers=USER_AGENT)
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read().decode("utf-8", "replace")
        except OSError:  # the LibriVox catalog returns a 522 now and then
            if attempt == attempts - 1:
                raise
            time.sleep(5 * (attempt + 1))
    raise AssertionError


def _seconds(hms: str) -> int:
    parts = [int(p) for p in hms.split(":")]
    while len(parts) < 3:  # noqa: PLR2004 — hh:mm:ss
        parts.insert(0, 0)
    return parts[0] * 3600 + parts[1] * 60 + parts[2]


def _catalog_rows(catalog_url: str) -> list[tuple[str, list[str], int]]:
    """`(64 kbps mp3 URL, readers, duration in s)` per section of the LibriVox catalog."""
    page = _get(catalog_url)
    rows = []
    for row in re.findall(r"<tr>(.*?)</tr>", page, re.DOTALL):
        mp3 = re.search(r'href="([^"]+_64kb\.mp3)"', row)
        duration = re.search(r"<td>\s*(\d{1,2}:\d{2}:\d{2})\s*</td>", row)
        readers = [
            html.unescape(r).strip() for r in re.findall(r'href="https?://librivox\.org/reader/\d+">([^<]+)</a>', row)
        ]
        if mp3 and duration and readers:
            url = mp3.group(1).replace("://www.archive.org", "://archive.org")
            rows.append((url, readers, _seconds(duration.group(1))))
    return rows


def build_manifest() -> dict[str, Any]:
    """Sections per reader, only for readers with two or more sections (different sessions)."""
    by_reader: dict[str, list[dict[str, Any]]] = {}
    skipped = []
    for identifier in COLLECTIONS:
        meta = json.loads(_get(f"https://archive.org/metadata/{identifier}"))
        match = re.search(r"https?://librivox\.org/[^\"' <]+/", meta.get("metadata", {}).get("description", ""))
        try:
            rows = _catalog_rows(match.group(0).replace("http:", "https:", 1)) if match else []
        except OSError as exc:
            skipped.append({"collection": identifier, "error": str(exc)})
            continue
        if not rows:
            skipped.append({"collection": identifier, "catalog_rows": 0})
        for url, readers, duration in rows:
            if duration >= MIN_SECTION_S and len(readers) == 1:
                by_reader.setdefault(readers[0], []).append({"url": url, "duration_s": duration})
    readers = {}
    for reader, sections in sorted(by_reader.items()):
        # Sections from different collections first: more distinct recording sessions.
        sections.sort(key=lambda s: (s["url"].split("/")[4], -s["duration_s"]))
        distinct = []
        seen = set()
        for section in sections:
            collection = section["url"].split("/")[4]
            if collection not in seen:
                distinct.append(section)
                seen.add(collection)
        rest = [s for s in sections if s not in distinct]
        chosen = (distinct + rest)[:MAX_SECTIONS_PER_READER]
        if len(chosen) >= 2:  # noqa: PLR2004 — the minimum for a genuine pair across sessions
            readers[reader] = chosen
    return {"readers": readers, "skipped_collections": skipped}


# --- prepare: audio in the upload format and synthetic meetings -------------------------------


def _ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def _encode_upload(source: str, output: Path, *, cut_s: int | None = None) -> None:
    """Opus mono 16 kHz 32 kbps, like the upload (formato-audio-upload.md), and WAV for cutting."""
    extra = ["-t", str(cut_s)] if cut_s else []
    _ffmpeg(
        "-i",
        source,
        *extra,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "libopus",
        "-b:a",
        "32k",
        "-application",
        "voip",
        str(output),
    )


def prepare(manifest: dict[str, Any], work: Path, *, seed: int, meetings_per_round: int) -> None:
    """Download the sections (only the start), convert and assemble the meetings with the ground truth of the turns."""
    sections_dir = work / "sections"
    sections_dir.mkdir(parents=True, exist_ok=True)
    sections: list[dict[str, Any]] = []
    for reader, items in manifest["readers"].items():
        for index, item in enumerate(items):
            slug = re.sub(r"[^a-z0-9]+", "-", reader.lower()).strip("-")
            path = sections_dir / f"{slug}-{index}.ogg"
            if not path.exists():
                _encode_upload(item["url"], path, cut_s=SECTION_CUT_S)
            wav = path.with_suffix(".wav")
            if not wav.exists():
                _ffmpeg("-i", str(path), "-ac", "1", "-ar", "16000", str(wav))
            sections.append({"reader": reader, "section": f"{slug}-{index}", "wav": str(wav), "source": item["url"]})

    rng = random.Random(seed)
    meetings = []
    # Each round uses each section at most once: a section is a session, and two excerpts of the
    # same session never form a "genuine" pair.
    for round_index in range(meetings_per_round):
        pool = sections[:]
        rng.shuffle(pool)
        while len(pool) >= 2:  # noqa: PLR2004
            size = min(len(pool), rng.choice((2, 3, 3)))
            group: list[dict[str, Any]] = []
            for candidate in list(pool):
                if len(group) < size and all(g["reader"] != candidate["reader"] for g in group):
                    group.append(candidate)
                    pool.remove(candidate)
            if len(group) < 2:  # noqa: PLR2004 — only one reader left
                break
            meetings.append(_assemble(work, len(meetings), round_index, group, rng))
    (work / "meetings.json").write_text(json.dumps(meetings, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(sections)} sections, {len(meetings)} meetings")


def _assemble(
    work: Path, number: int, round_index: int, group: list[dict[str, Any]], rng: random.Random
) -> dict[str, Any]:
    """A meeting: alternating turns until each reader reaches the target speech; audio in the upload format."""
    targets = {g["section"]: rng.choice(TALK_TARGETS_S) for g in group}
    # The offset within the section varies per round, so two rounds do not repeat the same excerpt.
    offsets = {g["section"]: 5.0 + round_index * 7.0 for g in group}
    spoken = dict.fromkeys(targets, 0.0)
    pieces, turns = [], []
    clock = 0.0
    order = itertools.cycle(group)
    while any(spoken[s] < targets[s] for s in targets):
        member = next(order)
        section = member["section"]
        if spoken[section] >= targets[section]:
            continue
        length = min(rng.uniform(*TURN_S), targets[section] - spoken[section])
        pieces.append((member["wav"], offsets[section], length))
        turns.append({"reader": member["reader"], "section": section, "start": clock, "end": clock + length})
        offsets[section] += length
        spoken[section] += length
        clock += length + 0.4
    meeting_dir = work / "meetings"
    meeting_dir.mkdir(exist_ok=True)
    listing = meeting_dir / f"m{number:03d}.txt"
    silence = work / "silence.wav"
    if not silence.exists():
        _ffmpeg("-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "0.4", str(silence))
    lines = []
    for wav, offset, length in pieces:
        lines += [f"file '{wav}'", f"inpoint {offset:.2f}", f"outpoint {offset + length:.2f}", f"file '{silence}'"]
    listing.write_text("\n".join(lines) + "\n", encoding="utf-8")
    joined = meeting_dir / f"m{number:03d}.wav"
    _ffmpeg("-f", "concat", "-safe", "0", "-i", str(listing), "-c:a", "pcm_s16le", str(joined))
    output = meeting_dir / f"m{number:03d}.ogg"
    _encode_upload(str(joined), output)
    joined.unlink()
    listing.unlink()
    return {"id": f"m{number:03d}", "audio": str(output), "turns": turns, "targets": targets}


# --- embed: diarization with embeddings, like the worker -----------------------------------------


def embed(work: Path, output: Path, extra: list[dict[str, Any]]) -> None:
    """Run the `DiarizationPipeline` on each meeting and match the speakers to the readers."""
    import whisperx  # noqa: PLC0415 — only present in the GPU worker image
    from whisperx.diarize import DiarizationPipeline  # noqa: PLC0415

    from eclume_engines.hf_token import resolve_hf_token  # noqa: PLC0415
    from eclume_engines.whisperx_local import DIARIZATION_MODEL, EMBEDDING_MODEL  # noqa: PLC0415

    pipeline = DiarizationPipeline(model_name=DIARIZATION_MODEL, token=resolve_hf_token(), device="cuda")
    listed = work / "meetings.json"
    meetings = (json.loads(listed.read_text(encoding="utf-8")) if listed.exists() else []) + extra
    items, discarded = [], []
    for meeting in meetings:
        diarization, vectors = pipeline(whisperx.load_audio(meeting["audio"]), return_embeddings=True)
        for speaker, vector in (vectors or {}).items():
            spans = diarization[diarization["speaker"] == speaker][["start", "end"]].to_numpy().tolist()
            overlap: dict[tuple[str, str], float] = {}
            for turn in meeting["turns"]:
                for start, end in spans:
                    shared = min(end, turn["end"]) - max(start, turn["start"])
                    if shared > 0:
                        key = (turn["reader"], turn["section"])
                        overlap[key] = overlap.get(key, 0.0) + shared
            talk = sum(end - start for start, end in spans)
            if not overlap:
                discarded.append({"meeting": meeting["id"], "speaker": speaker, "talk_s": talk, "reason": "no reader"})
                continue
            (reader, section), best = max(overlap.items(), key=lambda kv: kv[1])
            if best < PURITY * sum(overlap.values()):
                discarded.append({"meeting": meeting["id"], "speaker": speaker, "talk_s": talk, "reason": "mixed"})
                continue
            items.append(
                {
                    "meeting": meeting["id"],
                    "reader": reader,
                    "section": section,
                    "talk_s": round(talk, 1),
                    "embedding": vector,
                }
            )
        print(f"{meeting['id']}: {len(vectors or {})} speakers", flush=True)
    output.write_text(
        json.dumps({"embedding_model": EMBEDDING_MODEL, "items": items, "discarded": discarded}, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"{len(items)} speakers matched, {len(discarded)} discarded")


# --- analyze: FPR/FNR by threshold, duration and comparison mode -------------------------------


def _unit(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in vector)) or 1.0
    return [x / norm for x in vector]


def _cos(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))


def _centroid(vectors: list[list[float]]) -> list[float]:
    return _unit([sum(column) / len(vectors) for column in zip(*vectors, strict=True)])


def _bucket(talk_s: float) -> str:
    for limit in (20, 45, 90, 180):
        if talk_s < limit:
            return f"<{limit}s"
    return ">=180s"


def score_trials(
    items: list[dict[str, Any]], *, enroll: int, mode: str, min_talk_s: float, seed: int
) -> list[tuple[float, bool, float]]:
    """`(score, same person?, test speech)` for each test against each voiceprint.

    A reader's voiceprint comes from `enroll` samples from sections different from the test's; the
    test is a speaker from another meeting. Only samples and tests with speech ≥ `min_talk_s` are used.
    """
    rng = random.Random(seed)
    usable = [dict(i, unit=_unit(i["embedding"])) for i in items if i["talk_s"] >= min_talk_s]
    readers = sorted({i["reader"] for i in usable})
    trials = []
    for test in usable:
        for reader in readers:
            pool = [
                i
                for i in usable
                if i["reader"] == reader and i["section"] != test["section"] and i["meeting"] != test["meeting"]
            ]
            if len(pool) < enroll:
                continue
            samples = rng.sample(pool, enroll)
            vectors = [s["unit"] for s in samples]
            if mode == "centroid":
                score = _cos(_centroid(vectors), test["unit"])
            elif mode == "max":
                score = max(_cos(v, test["unit"]) for v in vectors)
            else:  # "mean": average of the cosines with each sample
                score = statistics.fmean(_cos(v, test["unit"]) for v in vectors)
            trials.append((max(0.0, score), reader == test["reader"], test["talk_s"]))
    return trials


def rates(trials: list[tuple[float, bool, float]], threshold: float) -> tuple[float, float, int, int]:
    """`(FPR, FNR, impostors, genuine)` at the threshold."""
    genuine = [s for s, same, _ in trials if same]
    impostor = [s for s, same, _ in trials if not same]
    fpr = sum(s >= threshold for s in impostor) / len(impostor) if impostor else math.nan
    fnr = sum(s < threshold for s in genuine) / len(genuine) if genuine else math.nan
    return fpr, fnr, len(impostor), len(genuine)


def eer(trials: list[tuple[float, bool, float]]) -> tuple[float, float]:
    """`(EER, threshold)` by a fine sweep."""
    best = (1.0, 0.0)
    for step in range(1001):
        threshold = step / 1000
        fpr, fnr, _, _ = rates(trials, threshold)
        gap = abs(fpr - fnr)
        if gap < best[0]:
            best = (gap, threshold)
    fpr, fnr, _, _ = rates(trials, best[1])
    return (fpr + fnr) / 2, best[1]


def threshold_for_fpr(trials: list[tuple[float, bool, float]], target: float) -> float:
    """Lowest threshold (step 0.005) with FPR ≤ target."""
    for step in range(201):
        threshold = step / 200
        if rates(trials, threshold)[0] <= target:
            return threshold
    return 1.0


def analyze(data: dict[str, Any], *, seed: int) -> dict[str, Any]:
    """Calibration tables, as JSON and as text."""
    items = data["items"]
    report: dict[str, Any] = {
        "embedding_model": data.get("embedding_model"),
        "speakers": len(items),
        "readers": len({i["reader"] for i in items}),
        "sections": len({i["section"] for i in items}),
        "discarded": len(data.get("discarded", [])),
        "scenarios": [],
    }
    thresholds = [round(0.30 + 0.05 * k, 2) for k in range(13)]
    for mode, enroll, min_talk in [
        ("centroid", 1, 0),
        ("centroid", 3, 0),
        ("max", 3, 0),
        ("mean", 3, 0),
        ("centroid", 3, 20),
        ("centroid", 3, 45),
        ("max", 3, 20),
    ]:
        trials = score_trials(items, enroll=enroll, mode=mode, min_talk_s=min_talk, seed=seed)
        if not trials:
            continue
        rate_eer, at = eer(trials)
        thr1 = threshold_for_fpr(trials, 0.01)
        thr01 = threshold_for_fpr(trials, 0.001)
        scenario = {
            "mode": mode,
            "enroll": enroll,
            "min_talk_s": min_talk,
            "genuine": sum(1 for t in trials if t[1]),
            "impostor": sum(1 for t in trials if not t[1]),
            "eer": round(rate_eer, 4),
            "eer_threshold": at,
            "threshold_fpr_1pct": thr1,
            "fnr_at_fpr_1pct": round(rates(trials, thr1)[1], 4),
            "threshold_fpr_0_1pct": thr01,
            "fnr_at_fpr_0_1pct": round(rates(trials, thr01)[1], 4),
            "by_threshold": [
                {"threshold": th, "fpr": round(rates(trials, th)[0], 4), "fnr": round(rates(trials, th)[1], 4)}
                for th in thresholds
            ],
            "by_talk": {},
        }
        for bucket in ("<20s", "<45s", "<90s", "<180s", ">=180s"):
            subset = [t for t in trials if _bucket(t[2]) == bucket]
            if subset:
                fpr, fnr, n_imp, n_gen = rates(subset, thr1)
                scenario["by_talk"][bucket] = {
                    "fpr": round(fpr, 4),
                    "fnr": round(fnr, 4),
                    "impostor": n_imp,
                    "genuine": n_gen,
                }
        report["scenarios"].append(scenario)
    return report


def main(argv: list[str] | None = None) -> int:
    """CLI."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("manifest")
    p.add_argument("--out", type=Path, required=True)
    p = sub.add_parser("prepare")
    p.add_argument("manifest", type=Path)
    p.add_argument("--work", type=Path, required=True)
    p.add_argument("--seed", type=int, default=15)
    p.add_argument("--rounds", type=int, default=3, help="how many times each section enters a meeting")
    p = sub.add_parser("embed")
    p.add_argument("--work", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--extra", type=Path, help="JSON with extra meetings (`id`, `audio`, `turns`), like the 1 h bench")
    p = sub.add_parser("analyze")
    p.add_argument("embeddings", type=Path)
    p.add_argument("--seed", type=int, default=15)
    p.add_argument("--json", type=Path, help="write the report as JSON")
    args = parser.parse_args(argv)

    if args.command == "manifest":
        manifest = build_manifest()
        args.out.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        total = sum(len(v) for v in manifest["readers"].values())
        print(f"{len(manifest['readers'])} readers, {total} sections; skipped: {manifest['skipped_collections']}")
    elif args.command == "prepare":
        prepare(
            json.loads(args.manifest.read_text(encoding="utf-8")),
            args.work,
            seed=args.seed,
            meetings_per_round=args.rounds,
        )
    elif args.command == "embed":
        extra = json.loads(args.extra.read_text(encoding="utf-8")) if args.extra else []
        embed(args.work, args.out, extra)
    else:
        report = analyze(json.loads(args.embeddings.read_text(encoding="utf-8")), seed=args.seed)
        if args.json:
            args.json.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({k: v for k, v in report.items() if k != "scenarios"}, ensure_ascii=False))
        for s in report["scenarios"]:
            print(
                f"{s['mode']:>8} k={s['enroll']} speech>={s['min_talk_s']:>3}s  gen={s['genuine']:>5} imp={s['impostor']:>6}  "
                f"EER={s['eer']:.3f}@{s['eer_threshold']:.3f}  FPR1%@{s['threshold_fpr_1pct']:.3f} FNR={s['fnr_at_fpr_1pct']:.3f}  "
                f"FPR0.1%@{s['threshold_fpr_0_1pct']:.3f} FNR={s['fnr_at_fpr_0_1pct']:.3f}"
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
