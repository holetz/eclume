# ruff: noqa: INP001
"""pt-BR residue and frozen-literal scanner for the English translation of the source.

`pt_residue.py <path>...` walks `.py` and `.sql` files and reports every comment, docstring, log
message or argparse help whose text still reads as pt-BR: an accented letter or a pt-BR stopword,
after removing backtick and double-quoted spans (citations of frozen strings and UI labels). It
prints `<file>:<line>: <kind>` per hit, then `pt-BR residue: <n>` on stderr, and exits 1 when
anything is left. A docstring whose `class`/`def` line carries `# i18n-wave` is skipped: it reaches
an LLM and moves with the i18n wave.

`pt_residue.py --literals <file|->` prints, sorted, every Python string constant that is not a
docstring, a log message or argparse help: the set a translation must leave untouched. Diff it
between the base and the branch to prove no frozen string changed.
"""

from __future__ import annotations

import ast
import io
import re
import sys
import tokenize
from pathlib import Path

PT_BR = re.compile(
    r"[ãõçáéíóúâêôà]|\b(que|não|nao|para|uma|pelo|pela|pelos|sem|já|também|então|quando|depois|ainda|só"
    r"|cada|nunca|sempre|está|são|fica|ficam|volta|isso|esta|este|essa|esse|aqui|outra|outro|mesmo"
    r"|mesma|entre|sobre|até|vez)\b",
    re.IGNORECASE,
)
QUOTED = re.compile(r"`[^`]*`|\"[^\"\n]*\"|«[^»]*»")
SQL_LITERAL = re.compile(r"'(?:[^']|'')*'")
LOG_METHODS = {"debug", "info", "warning", "error", "exception", "critical"}
LOGGERS = {"log", "logger", "_log", "LOG", "logging", "access_log"}
ARGPARSE_CALLS = {"add_argument", "add_parser", "ArgumentParser", "add_subparsers", "add_argument_group"}
ARGPARSE_KEYWORDS = {"help", "description", "epilog"}
DOCUMENTED = (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)


def reads_pt_br(text: str) -> bool:
    """True when the text, without its quoted spans, has a pt-BR accent or stopword."""
    return PT_BR.search(QUOTED.sub(" ", text)) is not None


def _docstring_nodes(tree: ast.AST) -> list[tuple[ast.AST, ast.Constant]]:
    pairs = []
    for node in ast.walk(tree):
        if isinstance(node, DOCUMENTED) and node.body:
            first = node.body[0]
            if (
                isinstance(first, ast.Expr)
                and isinstance(first.value, ast.Constant)
                and isinstance(first.value.value, str)
            ):
                pairs.append((node, first.value))
    return pairs


def _prose_calls(tree: ast.AST) -> list[tuple[ast.Call, list[ast.AST]]]:
    """Log calls (first argument) and argparse calls (help, description, epilog) with their prose."""
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.attr if isinstance(func, ast.Attribute) else func.id if isinstance(func, ast.Name) else ""
        prose: list[ast.AST] = []
        if (
            name in LOG_METHODS
            and isinstance(func, ast.Attribute)
            and isinstance(func.value, ast.Name)
            and func.value.id in LOGGERS
            and node.args
        ):
            prose.append(node.args[0])
        if name in ARGPARSE_CALLS:
            prose += [keyword.value for keyword in node.keywords if keyword.arg in ARGPARSE_KEYWORDS]
        if prose:
            found.append((node, prose))
    return found


def _strings(node: ast.AST) -> list[ast.Constant]:
    return [c for c in ast.walk(node) if isinstance(c, ast.Constant) and isinstance(c.value, str)]


def scan_python(source: str) -> list[tuple[int, str]]:
    """The pt-BR hits of one Python source, as (line, kind)."""
    hits = [
        (token.start[0], "comment")
        for token in tokenize.generate_tokens(io.StringIO(source).readline)
        if token.type == tokenize.COMMENT and reads_pt_br(token.string)
    ]
    tree = ast.parse(source)
    lines = source.splitlines()
    for owner, doc in _docstring_nodes(tree):
        header = "" if isinstance(owner, ast.Module) else lines[owner.lineno - 1]
        if "i18n-wave" not in header and reads_pt_br(doc.value):
            hits.append((doc.lineno, "docstring"))
    for call, prose in _prose_calls(tree):
        if any(reads_pt_br(c.value) for part in prose for c in _strings(part)):
            hits.append((call.lineno, "log/help"))
    return sorted(set(hits))


def scan_sql(source: str) -> list[tuple[int, str]]:
    """The pt-BR hits of one SQL source: the `--` comment of each line, literals removed first."""
    hits = []
    for number, line in enumerate(source.splitlines(), start=1):
        code = SQL_LITERAL.sub("''", line)
        if "--" in code and reads_pt_br(code.split("--", 1)[1]):
            hits.append((number, "comment"))
    return hits


def frozen_literals(source: str) -> list[str]:
    """Every string constant that is not a docstring, a log message or argparse help, sorted."""
    tree = ast.parse(source)
    prose = {id(doc) for _, doc in _docstring_nodes(tree)}
    for _, parts in _prose_calls(tree):
        prose |= {id(c) for part in parts for c in _strings(part)}
    return sorted(repr(c.value) for c in _strings(tree) if id(c) not in prose)


def _files(args: list[str]) -> list[Path]:
    paths = []
    for arg in args:
        path = Path(arg)
        if path.is_dir():
            paths += sorted(p for p in path.rglob("*") if p.suffix in {".py", ".sql"})
        else:
            paths.append(path)
    return paths


def main(argv: list[str]) -> int:
    """Scan the paths, or print the frozen literals of one file with `--literals`."""
    if argv[:1] == ["--literals"]:
        source = sys.stdin.read() if argv[1] == "-" else Path(argv[1]).read_text(encoding="utf-8")
        sys.stdout.write("".join(f"{literal}\n" for literal in frozen_literals(source)))
        return 0
    count = 0
    for path in _files(argv):
        source = path.read_text(encoding="utf-8")
        hits = scan_sql(source) if path.suffix == ".sql" else scan_python(source)
        sys.stdout.write("".join(f"{path}:{line}: {kind}\n" for line, kind in hits))
        count += len(hits)
    sys.stderr.write(f"pt-BR residue: {count}\n")
    return 1 if count else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
