"""Shared runtime helpers for GENERATED matplotlib code -- logic
substantial enough that re-deriving it inline in every generated script
would be error-prone and hard to keep consistent is defined once here (as
regular importable functions) instead, exactly the role `vl2ggplot`'s own
`R/runtime.R` (`vl_pivot()`, `vl_truthy()`) and `vl2d3`'s shared JS runtime
module play for their own translators.

A generated script only imports from here when it actually calls one of
these -- `translator.py`'s own `Emitter` auto-detects a `vl_*(` call in any
statement it adds and threads the matching `from vl2matplotlib.runtime
import ...` into the script's own header, so a script that never needs
this module never imports it.
"""

from __future__ import annotations

import pandas as pd


def vl_window(
    df: "pd.DataFrame",
    window: list[dict],
    groupby: list[str] | None = None,
    sort: list[dict] | None = None,
    frame: tuple | None = None,
) -> "pd.DataFrame":
    """Vega-Lite's `window` transform: for each row, one or more windowed
    rank/aggregate values computed over a *frame* of rows relative to it,
    within an optional partition (`groupby`) and order (`sort`).

    `window` is a list of `{"op": ..., "field": ..., "as": ...}` dicts
    (`field` omitted for `row_number`/`rank`/`dense_rank`/`count`). `sort`
    is Vega-Lite's own list of `{"field": ..., "order": "ascending"|
    "descending"}` dicts. `frame` is a `(start, end)` pair of row offsets
    *relative to the current row* (Vega-Lite's own convention) -- `None`
    for either end means unbounded in that direction; `frame=None`
    (nothing specified at all) means the whole partition, matching
    Vega-Lite's own default when no `frame` is given.

    Supported ops: `row_number`, `rank`, `dense_rank`, `count`, `sum`,
    `mean`/`average`, `min`, `max`, `distinct`. Ops this doesn't implement
    (`lag`/`lead`/`first_value`/`last_value`/`percent_rank`/`cume_dist`/
    `ntile`, `median`/`stdev`/`variance`/`q1`/`q3`/`ci0`/`ci1`) fall back to
    the row's own `field` value unchanged -- a documented simplification,
    not a silent wrong answer masquerading as a real one.
    """
    groupby = groupby or []
    sort = sort or []
    order_fields = [s["field"] if isinstance(s, dict) else s for s in sort]
    order_ascending = [not (isinstance(s, dict) and s.get("order") == "descending") for s in sort]
    lo_off, hi_off = frame if frame is not None else (None, None)

    def _process_partition(g: "pd.DataFrame") -> "pd.DataFrame":
        if order_fields:
            g = g.sort_values(order_fields, ascending=order_ascending, kind="mergesort")
        g = g.reset_index(drop=True)
        n = len(g)
        for spec in window:
            op, field, out = spec["op"], spec.get("field"), spec["as"]
            if op == "row_number":
                g[out] = range(1, n + 1)
            elif op in ("rank", "dense_rank"):
                key = g[order_fields[0]] if order_fields else pd.Series(range(n))
                g[out] = key.rank(method="min" if op == "rank" else "dense").astype(int)
            else:
                vals = g[field] if field else None
                col = []
                for i in range(n):
                    lo = 0 if lo_off is None else max(0, i + lo_off)
                    hi = (n - 1) if hi_off is None else min(n - 1, i + hi_off)
                    if op == "count":
                        col.append(hi - lo + 1)
                    elif vals is None:
                        col.append(None)
                    elif op == "sum":
                        col.append(vals.iloc[lo : hi + 1].sum())
                    elif op in ("mean", "average"):
                        col.append(vals.iloc[lo : hi + 1].mean())
                    elif op == "min":
                        col.append(vals.iloc[lo : hi + 1].min())
                    elif op == "max":
                        col.append(vals.iloc[lo : hi + 1].max())
                    elif op == "distinct":
                        col.append(vals.iloc[lo : hi + 1].nunique())
                    else:
                        col.append(vals.iloc[i])
                g[out] = col
        return g

    if groupby:
        result = df.groupby(groupby, group_keys=False, dropna=False).apply(_process_partition)
    else:
        result = _process_partition(df)
    return result.reset_index(drop=True)
