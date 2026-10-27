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

`--tests`, before either form, widens the prose to what a test file also carries for developers:
assert messages and skip reasons (`pytest.skip/fail/xfail` message, any `reason=`). The scan then
also reports identifiers (definitions, arguments, assignment targets) with a pt-BR word among their
`_`-separated tokens, a heuristic floor rather than a proof.
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
SKIP_CALLS = {"skip", "fail", "xfail"}
PT_BR_TOKENS = frozenset(
    (  # noqa: SIM905 -- one word list reads better than a 70-line literal
        "de da das dos nao sem com para pelo pela pelos pelas uma um ao aos na nas nos que ja so quando"
        " depois ainda cada nunca sempre sao fica ficam vira isso outro outra outros outras mesmo mesma"
        " entre sobre ate retorna recusa aceita devolve cria apaga gera falha deve nega conta usuario"
        " gravacao gravacoes transcricao resumo pessoa pessoas pauta campo campos arquivo fila filas erro"
        " dono novo nova"
    ).split()
)
PT_BR_JOINERS = frozenset({"e", "o", "os"})


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


def _test_prose(tree: ast.AST) -> list[tuple[int, str, ast.AST]]:
    """Assert messages and skip reasons, as (line, kind, prose node)."""
    found: list[tuple[int, str, ast.AST]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Assert) and node.msg is not None:
            found.append((node.lineno, "assert-msg", node.msg))
        elif isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute) and func.attr in SKIP_CALLS and node.args:
                found.append((node.lineno, "skip-reason", node.args[0]))
            found += [(node.lineno, "skip-reason", kw.value) for kw in node.keywords if kw.arg == "reason"]
    return found


def reads_pt_br_name(name: str) -> bool:
    """True when an identifier has a pt-BR word among its `_`-separated tokens."""
    tokens = [token for token in name.lower().split("_") if token]
    return any(t in PT_BR_TOKENS or (len(tokens) > 1 and t in PT_BR_JOINERS) for t in tokens)


def _names(tree: ast.AST) -> list[tuple[int, str]]:
    """Defined identifiers: functions, classes, arguments and assignment targets, as (line, name)."""
    found = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            found.append((node.lineno, node.name))
        elif isinstance(node, ast.arg):
            found.append((node.lineno, node.arg))
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            found.append((node.lineno, node.id))
        elif isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Store):
            found.append((node.lineno, node.attr))
    return found


def _strings(node: ast.AST) -> list[ast.Constant]:
    return [c for c in ast.walk(node) if isinstance(c, ast.Constant) and isinstance(c.value, str)]


def scan_tests(source: str) -> list[tuple[int, str]]:
    """The pt-BR hits of one test file: `scan_python`, plus test prose and identifiers."""
    tree = ast.parse(source)
    hits = scan_python(source)
    hits += [
        (line, kind) for line, kind, part in _test_prose(tree) if any(reads_pt_br(c.value) for c in _strings(part))
    ]
    hits += [(line, f"name {name}") for line, name in _names(tree) if reads_pt_br_name(name)]
    return sorted(set(hits))


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


def frozen_literals(source: str, *, tests: bool = False) -> list[str]:
    """Every string constant that is not prose, sorted.

    Prose is a docstring, a log message or argparse help; with `tests`, also assert messages and
    skip reasons.
    """
    tree = ast.parse(source)
    prose = {id(doc) for _, doc in _docstring_nodes(tree)}
    for _, parts in _prose_calls(tree):
        prose |= {id(c) for part in parts for c in _strings(part)}
    if tests:
        prose |= {id(c) for _, _, part in _test_prose(tree) for c in _strings(part)}
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
    """Scan the paths, or print the frozen literals of one file with `--literals`.

    A leading `--tests` widens both to test files.
    """
    tests = argv[:1] == ["--tests"]
    if tests:
        argv = argv[1:]
    if argv[:1] == ["--literals"]:
        source = sys.stdin.read() if argv[1] == "-" else Path(argv[1]).read_text(encoding="utf-8")
        sys.stdout.write("".join(f"{literal}\n" for literal in frozen_literals(source, tests=tests)))
        return 0
    scan = scan_tests if tests else scan_python
    count = 0
    for path in _files(argv):
        source = path.read_text(encoding="utf-8")
        hits = scan_sql(source) if path.suffix == ".sql" else scan(source)
        sys.stdout.write("".join(f"{path}:{line}: {kind}\n" for line, kind in hits))
        count += len(hits)
    sys.stderr.write(f"pt-BR residue: {count}\n")
    return 1 if count else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
