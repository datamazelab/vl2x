"""Map a Vega-Lite `timeUnit` name to the Python expression that derives it
from a single already-`pd.to_datetime()`-coerced row value (`row[<field>]`,
a `pd.Timestamp`) -- used both for an encoding channel's own inline
`timeUnit` (`prepare.py`) and a top-level `timeUnit` transform
(`transforms.py`), both of which apply this expression via `df.apply(lambda
row: ..., axis=1)`, the same row-at-a-time convention `expr.py`'s
`calculate`/`filter` translation already uses.

A **combined** unit (`yearmonth`, `yearmonthdate`, `yearquarter`, ...) needs
a genuine truncated date -- rows from different years must still compare/
sort correctly -- so those reconstruct a real `pd.Timestamp` at the
matching granularity. A **single cyclic** unit (`year`/`quarter`/`month`/
`date`/`day`/`hours`/`minutes`/`seconds`/`dayofyear`) is scoped down to the
bare integer component instead of a dummy same-year comparable date the way
`vl2d3`/`vl2ggplot` both do -- correct for grouping/sorting, but the x-axis
then shows plain numbers (`1`-`12` for month) rather than a name ("Jan") the
way a real Vega-Lite chart's own cyclic label expression would; a
documented v1 gap, not an oversight.
"""

from __future__ import annotations

_CYCLIC = {
    "year": "{0}.year",
    "quarter": "{0}.quarter",
    "month": "{0}.month",
    "date": "{0}.day",
    "day": "({0}.dayofweek + 1) % 7",  # Vega-Lite's own day-of-week: 0 = Sunday
    "dayofyear": "{0}.dayofyear",
    "hours": "{0}.hour",
    "minutes": "{0}.minute",
    "seconds": "{0}.second",
    "milliseconds": "{0}.microsecond // 1000",
}

# `pd.Timestamp(year, month, day)` construction for each combined unit --
# whichever of year/month/day this unit doesn't itself carry falls back to a
# fixed value (month/day default to 1, matching "truncate to the start of
# this bucket"). The fixed placeholder year for a year-less unit
# (`quartermonth`/`monthdate`) is 2000, not (e.g.) 1900 -- 2000 is a leap
# year (divisible by 400), so reconstructing a real date's own month/day
# (`monthdate`'s whole reason for existing) never raises `day is out of
# range for month` for a February 29th, something a non-leap placeholder
# year would.
_COMBINED = {
    "yearquarter": "pd.Timestamp({0}.year, 3 * (({0}.month - 1) // 3) + 1, 1)",
    "yearmonth": "pd.Timestamp({0}.year, {0}.month, 1)",
    "yearmonthdate": "pd.Timestamp({0}.year, {0}.month, {0}.day)",
    "quartermonth": "pd.Timestamp(2000, {0}.month, 1)",
    "monthdate": "pd.Timestamp(2000, {0}.month, {0}.day)",
}

SUPPORTED_UNITS = set(_CYCLIC) | set(_COMBINED)


def is_supported_timeunit(unit: object) -> bool:
    name = unit["unit"] if isinstance(unit, dict) else unit
    return isinstance(name, str) and name in SUPPORTED_UNITS


def timeunit_expr(unit: object, value_expr: str) -> str:
    """`unit` is either a bare string (`"yearmonth"`) or `{"unit": ...,
    "step": ...}` (a binned time unit -- the `step` is dropped, only the
    base unit honored, matching `vl2d3`/`vl2ggplot`'s identical
    simplification). `value_expr` is the already-rendered Python expression
    for the raw datetime value (e.g. `row['date']`)."""
    name = unit["unit"] if isinstance(unit, dict) else unit
    if name in _COMBINED:
        return _COMBINED[name].format(value_expr)
    if name in _CYCLIC:
        return _CYCLIC[name].format(value_expr)
    raise ValueError(f"Unsupported timeUnit: {name!r}")
