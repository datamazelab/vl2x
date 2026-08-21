"""Translate Vega-Lite ``transform`` array entries into ``.transform_*`` calls."""

from __future__ import annotations

from .calls import render_kwargs
from .literals import format_value

# Each entry: primary_key -> (method_name, {json_key: python_param_name})
# The mapping only needs to rename keys that collide with Python keywords;
# everything else passes through the generic safe/unsafe kwargs splitter.
_TRANSFORM_TABLE = {
    "filter": ("transform_filter", None),  # handled specially (positional arg)
    "calculate": ("transform_calculate", {"as": "as_"}),
    "aggregate": ("transform_aggregate", {}),
    "bin": ("transform_bin", {"as": "as_"}),
    "timeUnit": ("transform_timeunit", {"as": "as_"}),
    "fold": ("transform_fold", {"as": "as_"}),
    "flatten": ("transform_flatten", {"as": "as_"}),
    "joinaggregate": ("transform_joinaggregate", {}),
    "stack": ("transform_stack", {"as": "as_"}),
    "impute": ("transform_impute", {}),
    "pivot": ("transform_pivot", {}),
    "quantile": ("transform_quantile", {"as": "as_"}),
    "regression": ("transform_regression", {"as": "as_"}),
    "loess": ("transform_loess", {"as": "as_"}),
    "sample": ("transform_sample", {}),
    "density": ("transform_density", {"as": "as_"}),
    "extent": ("transform_extent", {}),
    "window": ("transform_window", {}),
    "lookup": ("transform_lookup", {"as": "as_", "from": "from_"}),
}

# Order matters only in that we look for the first matching primary key.
_PRIMARY_KEYS_IN_ORDER = list(_TRANSFORM_TABLE)


def render_transform_call(transform: dict) -> str | None:
    """Return a ``.transform_x(...)`` chain suffix (without the leading dot).

    Returns ``None`` if the transform's type isn't recognized (this covers
    the complete set of transform types in the current Vega-Lite schema, so
    ``None`` should only happen for a future/unknown transform type); callers
    should fall back to appending the raw dict directly to ``chart.transform``.
    """
    primary = next((k for k in _PRIMARY_KEYS_IN_ORDER if k in transform), None)
    if primary is None:
        return None

    method, rename = _TRANSFORM_TABLE[primary]

    if primary == "filter":
        return f"{method}({format_value(transform['filter'])})"

    kwargs = dict(transform)
    return f"{method}({render_kwargs(kwargs, rename=rename)})"
