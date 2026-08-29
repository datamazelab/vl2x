"""Best-effort translation of a Vega expression string (used by `filter` and
`calculate` transforms) into a Python expression, evaluated one row at a time
via `df.apply(lambda row: <expr>, axis=1)` (or, for a `filter`, `df[df.apply(
lambda row: <expr>, axis=1)]`) -- a row-at-a-time closure rather than a
vectorized pandas expression is far simpler to generate correctly for
arbitrary Vega expression syntax (Python and JS share most operators
already, so most of this is table lookups), at the cost of raw execution
speed nothing in this project's own corpus-sized examples will ever notice.

Not a real parser: like `vl2d3`'s own `expr.js` and `vl2ggplot`'s own
`expr.R`, this is a sequence of targeted regex/string rewrites over the
*already len-decreasing* set of Vega expression shapes real Vega-Lite specs
actually use (arithmetic/comparison/logical operators, `datum.field`
references, a ternary, common `Math.*`/string functions) -- anything past
that is passed through as literal text and left to fail loudly at generated-
code run time rather than silently miscalculating.
"""

from __future__ import annotations

import re

# JS and Python already share: + - * / % (Python's is real modulo, matching
# JS's for same-sign operands, which covers every real-world use in this
# corpus) < <= > >= == !=  and parenthesization -- nothing to rewrite there.
def _rewrite_ternary_in_groups(expr: str) -> str:
    """Recurse into each top-level `(...)`/`[...]`/`{...}` span's own inner
    content and apply `_rewrite_ternary` to it as its own "local top level"
    -- needed because a ternary is often an ARGUMENT to a function call
    (`toString(a ? b : c)`), not the whole expression, so the depth-0 scan
    in `_rewrite_ternary` itself would never see it (depth is 1 the entire
    time it's inside that call's parens)."""
    out = []
    i, n = 0, len(expr)
    while i < n:
        ch = expr[i]
        if ch == "'" or ch == '"':
            j = expr.find(ch, i + 1)
            j = n - 1 if j == -1 else j
            out.append(expr[i : j + 1])
            i = j + 1
            continue
        if ch in "([{":
            depth = 1
            j = i + 1
            while j < n and depth > 0:
                cj = expr[j]
                if cj == "'" or cj == '"':
                    k = expr.find(cj, j + 1)
                    j = n - 1 if k == -1 else k
                elif cj in "([{":
                    depth += 1
                elif cj in ")]}":
                    depth -= 1
                j += 1
            inner_end = j - 1 if depth == 0 else n
            inner = expr[i + 1 : inner_end]
            closer = expr[inner_end] if inner_end < n else ""
            out.append(ch + _rewrite_ternary(inner) + closer)
            i = inner_end + 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _rewrite_ternary(expr: str) -> str:
    """`cond ? a : b` -> `(a) if (cond) else (b)`, applied innermost-first
    via simple bracket-depth-aware splitting (a hand-rolled scan, not a real
    parser, since Python has no ternary operator to lean on syntactically the
    way the `?:` rewrite could if this were staying within a C-like target).
    Nested-inside-a-function-call ternaries are handled first, by recursing
    into every bracketed group via `_rewrite_ternary_in_groups`, before this
    level's own depth-0 scan runs on what's left."""
    expr = _rewrite_ternary_in_groups(expr)
    depth = 0
    q_pos = c_pos = None
    i, n = 0, len(expr)
    while i < n:
        ch = expr[i]
        if ch == "'" or ch == '"':
            # Skip over the *entire* quoted string literal (advancing `i`
            # past its closing quote) so a literal "?" or ":" inside it is
            # never mistaken for the ternary's own punctuation, and so the
            # closing quote itself is never re-examined as if it were a new
            # opening quote (which -- back when this only checked `find`
            # without actually skipping -- searched for a further quote
            # *after* the closing one, found none, and aborted the scan).
            j = expr.find(ch, i + 1)
            i = (j + 1) if j != -1 else n
            continue
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif depth == 0 and ch == "?" and q_pos is None:
            q_pos = i
        elif depth == 0 and ch == ":" and q_pos is not None and c_pos is None:
            c_pos = i
        i += 1
    if q_pos is None or c_pos is None:
        return expr
    cond = expr[:q_pos].strip()
    then = _rewrite_ternary(expr[q_pos + 1 : c_pos].strip())
    else_ = _rewrite_ternary(expr[c_pos + 1 :].strip())
    return f"({then}) if ({cond}) else ({else_})"


def _rewrite_datum_refs(expr: str) -> str:
    # `datum.field_name` (a bare identifier path) and `datum['field with
    # spaces']`/`datum["field.with.dots"]` (Vega-Lite's own bracket form for
    # any field name that isn't a valid bare identifier) both become
    # `row[<field>]` -- `row` is the per-row Series `df.apply(lambda row:
    # ..., axis=1)` binds, so both forms collapse to the same plain
    # dict/Series lookup regardless of which the original expression used.
    def repl_dot(m: re.Match) -> str:
        return f"row[{m.group(1)!r}]"

    def repl_bracket(m: re.Match) -> str:
        return f"row[{m.group(1)}]"

    expr = re.sub(r"datum\.([A-Za-z_][A-Za-z0-9_]*)", repl_dot, expr)
    expr = re.sub(r"datum\[([^\]]+)\]", repl_bracket, expr)
    return expr


_LOGICAL_REPLACEMENTS = [
    (re.compile(r"&&"), " and "),
    (re.compile(r"\|\|"), " or "),
    (re.compile(r"===?"), "=="),
    (re.compile(r"!==?(?!=)"), "!="),
    # A bare unary "!" (not part of "!=", already handled above) -> "not ".
    (re.compile(r"!(?!=)"), "not "),
]

# `Math.foo(...)` -> a Python equivalent. `min`/`max`/`abs`/`round` are
# builtins; everything else routes through the `math` module (imported by
# the generated script's own header whenever `calculate`/`filter` needs it
# -- see `translator.py`'s own conditional-import logic, mirroring how
# `vl2d3`'s generated code only imports its runtime helper when needed).
_MATH_FUNCS = {
    "Math.floor": "math.floor",
    "Math.ceil": "math.ceil",
    "Math.round": "round",
    "Math.abs": "abs",
    "Math.sqrt": "math.sqrt",
    "Math.pow": "pow",
    "Math.min": "min",
    "Math.max": "max",
    "Math.log": "math.log",
    "Math.log2": "math.log2",
    "Math.log10": "math.log10",
    "Math.exp": "math.exp",
    "Math.sin": "math.sin",
    "Math.cos": "math.cos",
    "Math.tan": "math.tan",
    "Math.asin": "math.asin",
    "Math.acos": "math.acos",
    "Math.atan": "math.atan",
    "Math.atan2": "math.atan2",
    "Math.sinh": "math.sinh",
    "Math.cosh": "math.cosh",
    "Math.tanh": "math.tanh",
    "Math.hypot": "math.hypot",
    "Math.trunc": "math.trunc",
    "Math.PI": "math.pi",
    "Math.random": "__import__('random').random",
}

# Vega's own expression language *also* exposes every one of these as a
# bare (non-"Math."-prefixed) top-level function -- `ceil(x)`, not just
# `Math.ceil(x)`. Matched with a word-boundary-aware regex (not a plain
# `.replace()`, unlike `_MATH_FUNCS` above) so a real field/variable name
# that merely *contains* one of these as a substring (`"amin"`, `"logged"`)
# is never mistaken for a call to it.
_BARE_MATH_FUNCS = {
    "ceil": "math.ceil",
    "floor": "math.floor",
    "round": "round",
    "abs": "abs",
    "sqrt": "math.sqrt",
    "pow": "pow",
    "min": "min",
    "max": "max",
    "log": "math.log",
    "log2": "math.log2",
    "log10": "math.log10",
    "exp": "math.exp",
    "sin": "math.sin",
    "cos": "math.cos",
    "tan": "math.tan",
    "asin": "math.asin",
    "acos": "math.acos",
    "atan": "math.atan",
    "atan2": "math.atan2",
    "sinh": "math.sinh",
    "cosh": "math.cosh",
    "tanh": "math.tanh",
    "hypot": "math.hypot",
    "trunc": "math.trunc",
    "random": "__import__('random').random",
}

# A handful of other bare Vega expression functions with a direct one-arg
# Python/pandas equivalent -- `pd` is always available (the generated
# script's header imports it unconditionally), so unlike `_BARE_MATH_FUNCS`
# these never need a conditional `uses_math`-style import.
_BARE_MISC_FUNCS = {
    "toString": "str",
    "isValid": "pd.notna",
    "length": "len",
    # Vega's own explicit string-to-number coercion function -- distinct
    # from a bare unary `+` (deliberately *not* translated, see
    # `_MATH_FUNCS`'s own docstring for why: too easy to misfire on an
    # unrelated numeric `+`), `toNumber(...)` is unambiguous, always a
    # single-argument function call, so it's safe to map directly.
    "toNumber": "float",
}

# Vega's own date-component extraction functions (`year(datum.date)`,
# `hours(datum.date)`, ...) -- the exact same cyclic single-component
# extraction `timeunit.py`'s own `_CYCLIC` table already provides for a
# `timeUnit` (a datetime attribute read, `.year`/`.month`/...), reused here
# rather than duplicating that table, since a Vega expression's own
# date-component function and a channel/transform's own `timeUnit` name the
# identical operation.
_DATE_COMPONENT_RE = re.compile(
    r"\b(year|quarter|month|date|day|dayofyear|hours|minutes|seconds|milliseconds)\(row\[([^\]]+)\]\)"
)

_SUBSTRING_RE = re.compile(r"\bsubstring\(([^,()]+),\s*([^,()]+)(?:,\s*([^,()]+))?\)")


def _rewrite_substring(expr: str) -> str:
    """Vega's `substring(s, start[, end])` -> Python slicing (`s[start:end]`
    / `s[start:]`) -- not a bare-name-to-callable swap like the
    `_BARE_MISC_FUNCS` table above, since there's no single Python callable
    with this signature to point at."""
    def repl(m: re.Match) -> str:
        s, start, end = m.group(1).strip(), m.group(2).strip(), m.group(3)
        return f"{s}[{start}:{end.strip() if end else ''}]"

    return _SUBSTRING_RE.sub(repl, expr)


# Vega's `quantileUniform(p[, min, max])`/`quantileNormal(p[, mean, stdev])`
# -- the inverse CDF ("quantile function") of a Uniform/Normal distribution,
# most often paired with a `quantile` transform's own output probability
# (`point_quantile_quantile.vl.json`'s own Q-Q plot: `quantileUniform(datum.p)`/
# `quantileNormal(datum.p)`, comparing empirical quantiles against each
# distribution's theoretical ones). `quantileUniform` on its default [0, 1]
# domain is just the identity (no Python call needed at all); `quantileNormal`
# has no single bare Python builtin either, but the standard library's own
# `statistics.NormalDist` already provides exactly this (`.inv_cdf(p)`) with
# no extra dependency -- conditionally imported the same way `math`/
# `LineCollection` are (see `translator.py`'s own `Emitter.add_stmt()`).
_QUANTILE_UNIFORM_RE = re.compile(r"\bquantileUniform\(([^,()]+)(?:,\s*([^,()]+),\s*([^,()]+))?\)")
_QUANTILE_NORMAL_RE = re.compile(r"\bquantileNormal\(([^,()]+)(?:,\s*([^,()]+),\s*([^,()]+))?\)")


def _rewrite_quantile_funcs(expr: str) -> str:
    def repl_uniform(m: re.Match) -> str:
        p = m.group(1).strip()
        if m.group(2) and m.group(3):
            lo, hi = m.group(2).strip(), m.group(3).strip()
            return f"(({lo}) + ({p}) * (({hi}) - ({lo})))"
        return f"({p})"

    def repl_normal(m: re.Match) -> str:
        p = m.group(1).strip()
        if m.group(2) and m.group(3):
            mean, stdev = m.group(2).strip(), m.group(3).strip()
            return f"statistics.NormalDist({mean}, {stdev}).inv_cdf({p})"
        return f"statistics.NormalDist().inv_cdf({p})"

    expr = _QUANTILE_UNIFORM_RE.sub(repl_uniform, expr)
    expr = _QUANTILE_NORMAL_RE.sub(repl_normal, expr)
    return expr


_LITERAL_REPLACEMENTS = [
    (re.compile(r"\bnull\b"), "None"),
    (re.compile(r"\btrue\b"), "True"),
    (re.compile(r"\bfalse\b"), "False"),
]

# `datum.field === null` / `!== null` (by far the most common null-check
# shape in this corpus) rewrites, via `_LOGICAL_REPLACEMENTS`/
# `_LITERAL_REPLACEMENTS` above, to `row['field'] == None` / `!= None` --
# but a *missing* value in a numeric pandas column is `NaN`, not the Python
# singleton `None` (`NaN == None` is `False`), so a plain `==`/`!=` against
# `None` silently matches nothing. Rewritten to `pd.isna(...)`/
# `pd.notna(...)`, which handle both representations.
_NULL_COMPARISON_RE = re.compile(
    r"(row\[[^\]]+\](?:\.\w+)*)\s*(==|!=)\s*None\b|"
    r"\bNone\s*(==|!=)\s*(row\[[^\]]+\](?:\.\w+)*)"
)


def _rewrite_null_comparisons(expr: str) -> str:
    def repl(m: re.Match) -> str:
        operand = m.group(1) or m.group(4)
        op = m.group(2) or m.group(3)
        return f"pd.isna({operand})" if op == "==" else f"pd.notna({operand})"

    return _NULL_COMPARISON_RE.sub(repl, expr)


def _rewrite_date_components(expr: str) -> str:
    from .timeunit import timeunit_expr

    def repl(m: re.Match) -> str:
        unit, field_expr = m.group(1), m.group(2)
        return timeunit_expr(unit, f"row[{field_expr}]")

    return _DATE_COMPONENT_RE.sub(repl, expr)


_IF_CALL_RE = re.compile(r"(?<![A-Za-z0-9_])if\s*\(")


def _rewrite_if_calls(expr: str) -> str:
    """Vega's own `if(cond, then, else)` function (distinct from the `?:`
    ternary, but semantically identical) -> the same `(then) if (cond) else
    (else)` Python form `_rewrite_ternary` produces. Hand-scanned (not a
    single regex) because the 3 comma-separated arguments -- and any `if(...)`
    nested inside one of them, as real specs in this corpus do -- need
    bracket/quote-depth-aware splitting, the same reason `_rewrite_ternary`
    itself isn't a regex."""
    out = []
    i, n = 0, len(expr)
    while i < n:
        m = _IF_CALL_RE.match(expr, i)
        if not m:
            out.append(expr[i])
            i += 1
            continue
        j = m.end()
        depth = 1
        parts: list[str] = []
        part_start = j
        while j < n and depth > 0:
            ch = expr[j]
            if ch in "'\"":
                q = ch
                j += 1
                while j < n and expr[j] != q:
                    j += 1
            elif ch in "([{":
                depth += 1
            elif ch in ")]}":
                depth -= 1
                if depth == 0:
                    parts.append(expr[part_start:j])
            elif ch == "," and depth == 1:
                parts.append(expr[part_start:j])
                part_start = j + 1
            j += 1
        if len(parts) == 3:
            cond, then, else_ = (_rewrite_if_calls(p.strip()) for p in parts)
            out.append(f"({then}) if ({cond}) else ({else_})")
        else:
            out.append(expr[i:j])
        i = j
    return "".join(out)


def _rewrite_bare_math_funcs(expr: str) -> str:
    for name, py_name in {**_BARE_MATH_FUNCS, **_BARE_MISC_FUNCS}.items():
        # `(?<!\.)` -- not a match already qualified by a preceding `.`
        # (`math.ceil(`, `random.random(`), which `_MATH_FUNCS`'s own
        # `Math.foo` -> `math.foo` replacement (run first, below) can
        # already have produced; without it, this would double-rewrite
        # `math.ceil(` into `math.math.ceil(`.
        expr = re.sub(rf"(?<!\.)\b{name}(?=\s*\()", py_name, expr)
    return expr


_UNARY_PLUS_PREV_CHARS = set("(,?:+-*/%<>=!&|")


def _rewrite_unary_plus(expr: str) -> str:
    """A leading (unambiguously *unary*, not binary addition) `+`
    immediately followed by a `row[...]` bracket access or a parenthesized
    group -- JS's own unary `+` string-to-number coercion
    (`wheat_wages.vl.json`'s own `"+datum.year + 5"`,
    `"+datum.start + (+datum.end - +datum.start)/2"`). A `+` counts as
    unary here only when the previous non-whitespace character (if any) is
    one that can never end a value expression -- start-of-string, an
    operator, `(`, `,`, `?`, `:` -- distinguishing it from an ordinary
    *binary* `+` (addition), which this project deliberately does *not*
    auto-coerce (see `_MATH_FUNCS`'s own docstring for why: with no
    reliable way to tell "two numbers" from "a string and a number" from
    the expression text alone, guessing wrong there risks silently
    stringifying data that was never meant to be a string). Unary `+` has
    no such ambiguity -- it always means "coerce this one operand to a
    number" -- so only the immediately-following primary expression is
    wrapped in `float(...)`, matching JS's own unary-operator precedence
    (binds tighter than the binary `+`/`-` that commonly follows it in the
    same expression). Run *before* `_LOGICAL_REPLACEMENTS`/`_rewrite_ternary()`,
    while `&&`/`||`/`?`/`:` are still their own literal JS characters (not
    yet `and`/`or`/`if`/`else` words), so the single-character
    `_UNARY_PLUS_PREV_CHARS` lookback stays valid."""
    out = []
    i, n = 0, len(expr)
    prev = ""
    while i < n:
        ch = expr[i]
        if ch in "'\"":
            j = expr.find(ch, i + 1)
            j = n - 1 if j == -1 else j
            out.append(expr[i : j + 1])
            prev = expr[j]
            i = j + 1
            continue
        if ch == "+" and (prev == "" or prev in _UNARY_PLUS_PREV_CHARS):
            k = i + 1
            while k < n and expr[k].isspace():
                k += 1
            operand_end = None
            if expr[k : k + 4] == "row[":
                m, depth = k + 4, 1
                while m < n and depth > 0:
                    if expr[m] in "'\"":
                        q = expr.find(expr[m], m + 1)
                        m = (q + 1) if q != -1 else n
                        continue
                    if expr[m] == "[":
                        depth += 1
                    elif expr[m] == "]":
                        depth -= 1
                    m += 1
                operand_end = m
            elif k < n and expr[k] == "(":
                m, depth = k, 0
                while m < n:
                    if expr[m] in "'\"":
                        q = expr.find(expr[m], m + 1)
                        m = (q + 1) if q != -1 else n
                        continue
                    if expr[m] == "(":
                        depth += 1
                    elif expr[m] == ")":
                        depth -= 1
                        if depth == 0:
                            m += 1
                            break
                    m += 1
                operand_end = m
            if operand_end is not None:
                out.append(f"float({expr[k:operand_end]})")
                prev = ")"
                i = operand_end
                continue
        out.append(ch)
        if not ch.isspace():
            prev = ch
        i += 1
    return "".join(out)


def _split_top_level_plus(expr: str) -> list[str]:
    """Split `expr` on depth-0 `+` characters (skipping quoted strings and
    bracketed groups), returning each term with surrounding whitespace
    stripped. Used by `_rewrite_string_concat()` below -- run *after*
    `_rewrite_ternary()`, so every `?:` has already become an `if`/`else`
    expression with no bare `+`/`-` characters of its own to worry about."""
    terms = []
    depth = 0
    start = 0
    i, n = 0, len(expr)
    while i < n:
        ch = expr[i]
        if ch in "'\"":
            j = expr.find(ch, i + 1)
            i = (j + 1) if j != -1 else n
            continue
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif depth == 0 and ch == "+":
            terms.append(expr[start:i].strip())
            start = i + 1
        i += 1
    terms.append(expr[start:].strip())
    return terms


_QUOTED_STRING_RE = re.compile(r"^['\"].*['\"]$")
_TERNARY_SHAPE_RE = re.compile(r"^\((.*)\)\s+if\s+\(.*\)\s+else\s+\((.*)\)$")


def _strip_matching_outer_parens(term: str) -> str:
    """`((A) if (B) else (C))` -> `(A) if (B) else (C)` -- a ternary's own
    *original* JS-source parens (`(cond ? a : b)`, preserved literally by
    `_rewrite_ternary_in_groups()`) wrap the *already*-parenthesized `(A)
    if (B) else (C)` shape `_rewrite_ternary()` itself produces, one layer
    deeper than `_TERNARY_SHAPE_RE` expects. Strips *only* a genuinely
    redundant outer pair -- one whose opening paren's own matching close is
    the string's last character, not some other unrelated closing paren
    that merely happens to be there."""
    while term.startswith("(") and term.endswith(")"):
        depth = 0
        matches_at_end = True
        for idx, ch in enumerate(term):
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth == 0 and idx != len(term) - 1:
                    matches_at_end = False
                    break
        if not matches_at_end:
            break
        term = term[1:-1].strip()
    return term


def _looks_like_string_literal(term: str) -> bool:
    """Whether `term` (already `_rewrite_ternary()`-processed Python) is
    *definitely* a string -- a bare quoted literal, or a ternary (`(A) if
    (B) else (C)`, `_rewrite_ternary()`'s own output shape) whose both
    branches are. Used only to decide when `_rewrite_string_concat()` can
    safely coerce the *other* side of a `+` to a string too."""
    term = _strip_matching_outer_parens(term.strip())
    if _QUOTED_STRING_RE.match(term):
        return True
    m = _TERNARY_SHAPE_RE.match(term)
    if m:
        return _looks_like_string_literal(m.group(1)) and _looks_like_string_literal(m.group(2))
    return False


def _rewrite_string_concat(expr: str) -> str:
    """JS's `+` silently does string concatenation (coercing the *other*
    operand to a string) the moment either side is already a string --
    Python's `+` raises `TypeError` on a `str`/non-`str` mix instead. Only
    rewritten when a term is *unambiguously* a string (a literal, or a
    ternary whose both branches are literals -- the common `(cond ? '+' :
    '') + value` "sign prefix" idiom, e.g. `waterfall_chart.vl.json`'s own
    `text_amount` calculation): a bare field reference might be numeric or
    a string, unknowable from the expression text alone, so that case is
    left untouched entirely -- same reasoning `_MATH_FUNCS`'s own docstring
    already gives for why a bare unary `+` stays unimplemented."""
    if "+" not in expr:
        return expr
    terms = _split_top_level_plus(expr)
    if len(terms) < 2:
        return expr
    changed = False
    for i in range(len(terms) - 1):
        if _looks_like_string_literal(terms[i]) and not _looks_like_string_literal(terms[i + 1]):
            terms[i + 1] = f"str({terms[i + 1]})"
            changed = True
    return " + ".join(terms) if changed else expr


def translate_expr(expr: str) -> str:
    """Translate a single Vega expression string into a Python expression,
    assumed to run inside `lambda row: <result>` (or an f-string/format call
    for a `calculate` transform's own assignment)."""
    out = expr.strip()
    out = _rewrite_datum_refs(out)
    out = _rewrite_unary_plus(out)
    out = _rewrite_date_components(out)
    out = _rewrite_if_calls(out)
    out = _rewrite_substring(out)
    out = _rewrite_quantile_funcs(out)
    for pattern, repl in _LOGICAL_REPLACEMENTS:
        out = pattern.sub(repl, out)
    for pattern, repl in _LITERAL_REPLACEMENTS:
        out = pattern.sub(repl, out)
    out = _rewrite_null_comparisons(out)
    for js_name, py_name in _MATH_FUNCS.items():
        out = out.replace(js_name, py_name)
    out = _rewrite_bare_math_funcs(out)
    out = _rewrite_ternary(out)
    out = _rewrite_string_concat(out)
    return out


def expr_uses_math(expr: str) -> bool:
    return "math." in translate_expr(expr)
