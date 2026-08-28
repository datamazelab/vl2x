"""Small shared helpers for resolving one encoding channel definition --
field vs. literal `value`/`datum`, and the handful of properties every mark
renderer in `marks.py` needs to check the same way regardless of mark type.
Kept deliberately thin: each mark's own color/size/opacity *drawing* logic
lives in `marks.py` itself, next to the matplotlib call it feeds, rather
than behind a separate indirection layer here.
"""

from __future__ import annotations

from .literals import format_value


def has_field(def_: object) -> bool:
    return isinstance(def_, dict) and def_.get("field") is not None


_DATETIME_OBJECT_KEYS = {"year", "quarter", "month", "date", "hours", "minutes", "seconds", "milliseconds"}
_DATETIME_TO_TIMESTAMP_KW = {"date": "day"}  # Vega's own "date" means day-of-month; pd.Timestamp's kwarg is "day"


def _is_datetime_literal_object(v: object) -> bool:
    """Vega-Lite's own `DateTime` object shape -- `{"year": 2006}`,
    `{"month": 3, "date": 15}`, ... -- usable directly as a `datum` on a
    `temporal` channel (e.g. a rule mark's reference line at a specific
    date). Distinguished from an arbitrary plain dict (which
    `channel_value_expr()` would otherwise just literal-render, producing a
    dict matplotlib's date axis can't plot at all -- `"Failed to convert
    value(s) to axis units"`) by every one of its keys being a real
    `DateTime` field name."""
    return isinstance(v, dict) and bool(v) and set(v) <= _DATETIME_OBJECT_KEYS


def _datetime_literal_expr(v: dict) -> str:
    # `pd.Timestamp(...)` requires year/month/day all present (no partial-
    # construction default the way Vega's own DateTime object allows) --
    # `1`s filled in for whichever of those three this literal doesn't
    # itself specify, matching Vega-Lite's own "unspecified date parts
    # default to the start of that unit" convention.
    merged = {"year": v.get("year", 1), "month": v.get("month", 1), "date": v.get("date", 1)}
    merged.update({k: n for k, n in v.items() if k not in ("year", "month", "date")})
    kwargs = ", ".join(f"{_DATETIME_TO_TIMESTAMP_KW.get(k, k)}={n!r}" for k, n in merged.items())
    return f"pd.Timestamp({kwargs})"


def channel_value_expr(def_: dict) -> str:
    """A channel bound to a literal `value` (or `datum`, e.g. a repeat
    template's own `{"datum": {"repeat": "layer"}}`) rather than a `field` --
    returns the constant Python expression for it."""
    if "value" in def_:
        return format_value(def_["value"])
    if "datum" in def_:
        datum = def_["datum"]
        if _is_datetime_literal_object(datum):
            return _datetime_literal_expr(datum)
        return format_value(datum)
    raise ValueError("Internal: channel_value_expr() called on a field-bound channel")


def is_categorical_field(def_: dict) -> bool:
    return isinstance(def_, dict) and def_.get("type") in ("ordinal", "nominal")


def is_continuous_field(def_: dict) -> bool:
    return isinstance(def_, dict) and def_.get("type") in ("quantitative", "temporal")
