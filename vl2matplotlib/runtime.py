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

import numpy as np
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


def vl_density(
    df: "pd.DataFrame",
    field: str,
    groupby: list[str] | None = None,
    bandwidth: float | None = None,
    extent: tuple | None = None,
    steps: int = 200,
    counts: bool = False,
    as_names: tuple[str, str] = ("value", "density"),
) -> "pd.DataFrame":
    """Vega-Lite's `density` transform: a kernel density estimate of one
    field, replacing the data with (by default) `value`/`density` sample
    points tracing the estimated curve -- optionally one curve per
    `groupby` group. pandas/numpy have no built-in KDE convenience the way
    R's `stats::density()` does, so this computes a real (Gaussian-kernel)
    one directly: genuinely a KDE, not an approximation, though (like
    `vl2ggplot`'s `stats::density()`-based version and `vl2d3`'s own
    hand-rolled one) not guaranteed bit-for-bit identical to Vega's own.

    - `bandwidth`, if omitted, is computed per group via Silverman's rule
      of thumb (`0.9 * min(std, IQR / 1.34) * n ** -0.2`, R's `bw.nrd0`
      default -- the same one `vl2ggplot`'s `stats::density(bw = "nrd0")`
      call and `vl2d3`'s own inline version both already use).
    - `extent`, if omitted, is each group's own data min/max.
    - `steps` sample points are spaced evenly across the extent (default
      200, Vega-Lite's own default).
    - `counts=True` rescales the curve so its area equals the sample count
      instead of integrating to 1 (Vega-Lite's own definition).
    """
    value_name, density_name = as_names
    groupby = groupby or []

    def _kde(values: "np.ndarray") -> "pd.DataFrame":
        n = len(values)
        if n == 0:
            return pd.DataFrame({value_name: [], density_name: []})
        bw = bandwidth
        if bw is None:
            std = values.std(ddof=1) if n > 1 else 0.0
            q25, q75 = np.percentile(values, [25, 75])
            iqr = q75 - q25
            sigma = min(std, iqr / 1.34) if iqr > 0 else std
            sigma = sigma or 1.0
            bw = (0.9 * sigma * n ** -0.2) or 1.0
        lo, hi = extent if extent is not None else (float(values.min()), float(values.max()))
        xs = np.linspace(lo, hi, steps)
        diffs = (xs[:, None] - values[None, :]) / bw
        kernel = np.exp(-0.5 * diffs ** 2) / (bw * np.sqrt(2 * np.pi))
        density = kernel.mean(axis=1)
        if counts:
            density = density * n
        return pd.DataFrame({value_name: xs, density_name: density})

    if not groupby:
        values = df[field].dropna().to_numpy(dtype=float)
        return _kde(values)

    parts = []
    for key, g in df.groupby(groupby, dropna=False):
        keys = key if isinstance(key, tuple) else (key,)
        values = g[field].dropna().to_numpy(dtype=float)
        out = _kde(values)
        for gf, kv in zip(groupby, keys):
            out[gf] = kv
        parts.append(out)
    if not parts:
        return pd.DataFrame(columns=[value_name, density_name, *groupby])
    return pd.concat(parts, ignore_index=True)


_PIVOT_AGG_MAP = {
    "sum": "sum",
    "mean": "mean",
    "average": "mean",
    "count": "count",
    "min": "min",
    "max": "max",
    "median": "median",
}


def vl_pivot(
    df: "pd.DataFrame",
    field: str,
    value: str,
    groupby: list[str] | None = None,
    op: str = "sum",
    limit: int = 0,
) -> "pd.DataFrame":
    """Vega-Lite's `pivot` transform (`fold`'s inverse): one output column
    per distinct value of `field`, each holding that group's own `value`
    aggregated (`op`, default `"sum"`, Vega-Lite's own default) across
    every row sharing it -- one output row per distinct `groupby`
    combination (or a single row, aggregating the whole dataset, when
    `groupby` is empty). `limit`, if positive, keeps only the first
    `limit` distinct pivot values in their own sorted order (matching
    `vl2d3`'s own `vlPivot()`), dropping the rest entirely rather than
    just hiding extra columns after the fact.

    New column names are always coerced to `str()` -- Vega-Lite's own
    pivot always names each new column after the field's value the way a
    JS object key would (implicitly stringified, regardless of the
    field's own dtype), which matters concretely whenever a later
    transform refers to one of these columns by its own *string* literal
    (`trail_comet.vl.json`'s own `fold: ["1931", "1932"]` naming the
    output of pivoting a *numeric* `year` field) -- left as pandas' own
    raw (int/float) column dtype instead, that later string-keyed lookup
    fails outright even though the values are otherwise correct."""
    groupby = groupby or []
    keys = sorted(df[field].dropna().unique().tolist(), key=str)
    if limit and limit > 0:
        keys = keys[:limit]
    aggfunc = _PIVOT_AGG_MAP.get(op, "sum")
    filtered = df[df[field].isin(keys)]
    str_keys = [str(k) for k in keys]

    if groupby:
        pivoted = filtered.pivot_table(index=groupby, columns=field, values=value, aggfunc=aggfunc)
        pivoted = pivoted.reindex(columns=keys)
        pivoted.columns = str_keys
        return pivoted.reset_index()

    row = filtered.groupby(field)[value].agg(aggfunc).reindex(keys)
    out = pd.DataFrame([row.to_dict()], columns=keys)
    out.columns = str_keys
    return out


def vl_quantile(
    df: "pd.DataFrame",
    field: str,
    groupby: list[str] | None = None,
    step: float = 0.01,
    as_names: tuple[str, str] = ("prob", "value"),
) -> "pd.DataFrame":
    """Vega-Lite's `quantile` transform: replaces the data with empirical
    quantiles of `field`, sampled at evenly-spaced probabilities `step/2,
    step + step/2, ...` up to (not including) 1 -- Vega's own midpoint
    sampling convention, avoiding the ill-defined extremes at p=0/p=1 --
    optionally one set per `groupby` group. `np.quantile()`'s own default
    linear-interpolation method already matches Vega's own quantile
    algorithm closely enough for this project's "not guaranteed
    bit-for-bit identical" standard (see `vl_density()`'s own docstring
    for the same caveat)."""
    prob_name, value_name = as_names
    groupby = groupby or []
    probs = np.arange(step / 2, 1, step)

    def _quantiles(values: "pd.Series") -> "pd.DataFrame":
        vals = values.dropna().to_numpy(dtype=float)
        if len(vals) == 0:
            return pd.DataFrame({prob_name: [], value_name: []})
        return pd.DataFrame({prob_name: probs, value_name: np.quantile(vals, probs)})

    if not groupby:
        return _quantiles(df[field])

    parts = []
    for key, g in df.groupby(groupby, dropna=False):
        keys = key if isinstance(key, tuple) else (key,)
        out = _quantiles(g[field])
        for gf, kv in zip(groupby, keys):
            out[gf] = kv
        parts.append(out)
    if not parts:
        return pd.DataFrame(columns=[prob_name, value_name, *groupby])
    return pd.concat(parts, ignore_index=True)
