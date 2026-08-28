"""Map a Vega-Lite aggregate op name to the pandas expression that computes
it, for use inside a `.agg(...)` call (either the `DataFrame.agg({col:
func})` form for a groupless/global aggregate, or a named-aggregation
`.groupby(keys).agg(out=(col, func))` call for a grouped one -- see
`prepare.py`/`transforms.py`, both of which call `agg_expr()` below rather
than hand-rolling this table twice.

Most Vega-Lite op names either match a pandas/numpy built-in string
`.agg()` already recognizes verbatim ("sum", "mean", "median", "min",
"max", "count", "std", "var") or need a short lambda for the handful pandas
has no single built-in for (Vega-Lite's own `variancep`/`stdevp` are the
*population* variants -- pandas' own `var`/`std` default to the *sample*
variant, `ddof=1`; `valid`/`missing` count non-null/null rows; `distinct`
counts unique values; `q1`/`q3` are just `quantile(0.25)`/`quantile(0.75)`).
"""

from __future__ import annotations

# Vega-Lite op name -> a pandas `.agg()`-recognized string, when one exists
# verbatim.
_DIRECT = {
    "count": "count",
    "sum": "sum",
    "mean": "mean",
    "average": "mean",
    "median": "median",
    "min": "min",
    "max": "max",
    "variance": "var",
    "stdev": "std",
}

# Anything else needs a lambda over the column's own Series (`s`).
_LAMBDA = {
    "variancep": "lambda s: s.var(ddof=0)",
    "stdevp": "lambda s: s.std(ddof=0)",
    "valid": "lambda s: s.notna().sum()",
    "missing": "lambda s: s.isna().sum()",
    "distinct": "lambda s: s.nunique()",
    "q1": "lambda s: s.quantile(0.25)",
    "q3": "lambda s: s.quantile(0.75)",
    "ci0": "lambda s: s.mean() - 1.96 * s.std() / (len(s) ** 0.5)",
    "ci1": "lambda s: s.mean() + 1.96 * s.std() / (len(s) ** 0.5)",
}

SUPPORTED_OPS = set(_DIRECT) | set(_LAMBDA)


def is_supported_agg_op(op: object) -> bool:
    return isinstance(op, str) and op in SUPPORTED_OPS


def agg_expr(op: str) -> str:
    """The Python expression to use as the `func` argument of a pandas
    `.agg(...)` call for this op (a quoted built-in name, or a `lambda s:
    ...` expression) -- always a plain expression string, never itself
    calling anything, so it drops directly into either `.agg({col: EXPR})`
    or a named-aggregation `.agg(out=(col, EXPR))` tuple."""
    if op in _DIRECT:
        return repr(_DIRECT[op])
    if op in _LAMBDA:
        return _LAMBDA[op]
    raise ValueError(f"Unsupported aggregate op: {op!r}")
