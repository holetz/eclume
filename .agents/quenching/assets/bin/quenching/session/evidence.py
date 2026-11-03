"""What the parsed model is evidence OF — human turns attached to the command they
are about, and one command's bounded digest.

Moved verbatim out of the pre-refactor session script."""
from __future__ import annotations

from quenching.session.model import Command


def clip(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def assign_corrections(corrections: list, ordered: list) -> tuple[dict, list]:
    """Attach each human turn to the command it is evidence about.

    Inside a span is unambiguous. The harder case is the turn that lands just *after* one:
    an interrupt ENDS the span it belongs to, so the strongest evidence a command misfired
    always falls outside it by construction. Those attach to the command that just stopped,
    tagged `after` rather than `during`, because a report that cannot tell the two apart is
    guessing and should say so.
    """
    spans = [(c.first, c.last, c) for c in ordered if c.first is not None]
    spans.sort(key=lambda s: s[0])
    out, unassigned = {c.name: [] for c in ordered}, []
    for corr in corrections:
        line, hit = corr["line"], None
        for lo, hi, cmd in spans:
            if lo <= line <= hi:
                hit = (cmd, "during")
                break
        if hit is None:
            # the nearest span that ended before this turn, with no other span in between
            prior = [s for s in spans if s[1] < line]
            nxt = [s for s in spans if s[0] > line]
            if prior and (not nxt or prior[-1][1] < nxt[0][0]):
                hit = (prior[-1][2], "after")
        if hit is None:
            unassigned.append(corr)
        else:
            out[hit[0].name].append(dict(corr, when=hit[1]))
    return out, unassigned


def digest_command(cmd: Command, corrections: list, limit: int, cap: int) -> dict:
    """One command's evidence, bounded. Counts are exact; quotes are clipped."""
    repeated_reads = []
    for target, windows in cmd.reads.items():
        if len(windows) < 2:
            continue
        tally = {}
        for w in windows:
            tally[w] = tally.get(w, 0) + 1
        repeated_reads.append({
            "target": target,
            "count": len(windows),
            "windows": dict(sorted(tally.items(), key=lambda kv: (-kv[1], kv[0]))),
            # The same window fetched twice is a redundant read. Different windows are
            # paging through one file, which is the tool working as intended.
            "redundant": max(tally.values()) > 1,
        })
    repeated_reads.sort(key=lambda r: (-r["count"], r["target"]))

    repeated_shell = [{"command": clip(c, limit), "count": n}
                      for c, n in sorted(cmd.shell.items(), key=lambda kv: (-kv[1], kv[0]))
                      if n > 1]

    mine = corrections           # already attached to this command by assign_corrections

    out = cmd.as_dict()
    out["repeatedReads"] = repeated_reads[:cap]
    out["repeatedShell"] = repeated_shell[:cap]
    out["corrections"] = [{"line": c["line"], "timestamp": c["timestamp"],
                           "kind": c["kind"], "when": c["when"],
                           "quote": clip(c["text"], limit)}
                          for c in mine[:cap]]
    out["counts"] = {
        "toolCalls": cmd.tool_calls,
        "distinctFilesRead": len(cmd.reads),
        "distinctFilesWritten": len(cmd.touches),
        "writes": sum(cmd.touches.values()),
        "repeatedReadTargets": sum(1 for r in repeated_reads if r["redundant"]),
        "repeatedShellCommands": len(repeated_shell),
        "interrupts": sum(1 for c in mine if c["kind"] == "interrupt"),
        "interjections": sum(1 for c in mine if c["kind"] == "interjection"),
    }
    for key in ("repeatedReads", "repeatedShell", "corrections"):
        dropped = {"repeatedReads": len(repeated_reads), "repeatedShell": len(repeated_shell),
                   "corrections": len(mine)}[key] - len(out[key])
        if dropped > 0:
            out.setdefault("truncated", {})[key] = dropped
    return out
