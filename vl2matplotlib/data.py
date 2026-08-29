"""Render a Vega-Lite `data` definition into the Python statement(s) that
load it into a `pd.DataFrame`, plus a `render_temporal_coercion()` helper
every temporal field needs run afterwards (raw JSON only ever carries a
date as a string -- `pd.to_datetime()` is never implicit)."""

from __future__ import annotations

from .literals import format_value


def _dig(obj: object, dotted_path: str) -> object:
    """Vega-Lite's own `data.format.property` -- a dot-path into `values`
    naming where the *actual* record array lives (`"hits.hits"`,
    `"features"`), for a JSON envelope that isn't already a bare array at
    the top level (a common real-world API-response shape: `{hits: {hits:
    [...]}}`, `{type: "FeatureCollection", features: [...]}`)."""
    for key in dotted_path.split("."):
        if not isinstance(obj, dict) or key not in obj:
            return None
        obj = obj[key]
    return obj


def _flatten_record(record: dict, prefix: str = "") -> dict:
    """One JSON record -> a flat dict with dotted keys for any nested
    object value (`{"source": {"reco": 2}}` -> `{"source.reco": 2}`) --
    Vega-Lite's own convention for an *unescaped* dotted `field` reference
    (`"source.reco"`) is exactly this nested-object drill-down, and this
    flattening's dotted-key output happens to already match that reference
    string verbatim, so nothing downstream (`marks.py`/`prepare.py`/...)
    needs to know nested fields exist at all -- they see a perfectly
    ordinary flat column either way. A record that has no nested dict
    values at all (the overwhelmingly common case) passes through
    unchanged. A *list*-valued field (not a nested object) is left as a
    single column holding the list, same as before -- flattening it into
    rows is a `flatten` transform's own job (out of scope), not this."""
    out = {}
    for k, v in record.items():
        key = f"{prefix}{k}"
        if isinstance(v, dict):
            # The *nested* value itself is kept too (not just its own
            # flattened children) -- a Vega expression can check a whole
            # sub-object's own presence (`datum.options != null`, testing
            # for a row that lacks the key entirely) as well as reach into
            # one of its scalar fields (`field: "options.price"`); dropping
            # the nested key here would silently break the former.
            out[key] = v
            out.update(_flatten_record(v, prefix=f"{key}."))
        else:
            out[key] = v
    return out


def render_data_load(data: object, var_name: str, ignore_unsupported: bool = False) -> list[str]:
    """`data` is the parsed Vega-Lite `data` object (or None). Returns the
    statement(s) assigning `var_name` a `pd.DataFrame`."""
    if not data:
        return [f"{var_name} = pd.DataFrame()"]
    if "sequence" in data:
        # Vega-Lite's `sequence` generator: a synthetic dataset with one
        # numeric field (`as`, default `"data"`) stepping from `start`
        # (inclusive) to `stop` (exclusive) by `step` (default 1) --
        # `np.arange()` already has exactly this half-open, step-based
        # semantics, so no bespoke range logic is needed.
        seq = data["sequence"]
        start = format_value(seq.get("start", 0))
        stop = format_value(seq["stop"])
        step = format_value(seq.get("step", 1))
        field = seq.get("as", "data")
        return [f"{var_name} = pd.DataFrame({{{field!r}: np.arange({start}, {stop}, {step})}})"]
    if "values" in data:
        values = data["values"]
        # `format.property`: `values` itself is a JSON envelope object, not
        # already the bare records array -- drill into it first.
        prop = (data.get("format") or {}).get("property")
        if prop and isinstance(values, dict):
            dug = _dig(values, prop)
            if dug is not None:
                values = dug
        # Vega-Lite implicitly wraps a flat array of primitives (`[28, 55,
        # ...]`, as opposed to the usual array-of-records) into one-column
        # records named literally `"data"` -- `{"data": 28}`, `{"data":
        # 55}`, ... -- so `encoding`/`transform` can refer to a `"data"`
        # field the same way as any other. A bare `pd.DataFrame([28, 55])`
        # would instead produce an integer-named column (`0`), which the
        # rest of the generated code (referencing the field by name
        # `"data"`) would never find.
        if isinstance(values, list) and values and not any(isinstance(v, dict) for v in values):
            values = [{"data": v} for v in values]
        elif isinstance(values, list) and values and all(isinstance(v, dict) for v in values):
            values = [_flatten_record(v) for v in values]
        return [f"{var_name} = pd.DataFrame({format_value(values)})"]
    if "url" in data:
        url = data["url"]
        fmt = (data.get("format") or {}).get("type")
        if fmt is None:
            fmt = "csv" if str(url).endswith(".csv") else "tsv" if str(url).endswith(".tsv") else "json"
        if fmt == "csv":
            return [f"{var_name} = pd.read_csv({url!r})"]
        if fmt == "tsv":
            return [f"{var_name} = pd.read_csv({url!r}, sep='\\t')"]
        if fmt == "json":
            # `pd.read_json()` alone leaves a nested object value (e.g. a
            # `{"record": {"low": ..., "high": ...}}` field) as a raw dict
            # in an object-dtype column, not split into real columns the
            # way `field: "record.low"` needs -- round-tripped through
            # `pd.json_normalize()` (a no-op for already-flat JSON, so
            # always applied rather than only when nesting is suspected,
            # which isn't knowable without the real data loaded) to match
            # `data.py`'s own identical flattening for inline `values`.
            return [
                f"{var_name} = pd.read_json({url!r})",
                f"{var_name} = pd.json_normalize({var_name}.to_dict('records'), sep='.')",
            ]
        if ignore_unsupported:
            return [
                f"# vl2matplotlib: unsupported data format {fmt!r}, treating as JSON (ignore_unsupported)",
                f"{var_name} = pd.read_json({url!r})",
            ]
        raise ValueError(f"Unsupported: data format {fmt!r} is not yet supported by vl2matplotlib")
    if "name" in data:
        # A `datasets`-referenced name that resolve_dataset_refs() (translator.py)
        # didn't already resolve inline (should not normally happen -- every
        # `data: {name: ...}` reaching here is expected to have already been
        # rewritten to a real `values`/`url` def at the top of spec_to_code()).
        if ignore_unsupported:
            return [f"{var_name} = pd.DataFrame()  # vl2matplotlib: unresolved dataset reference (ignore_unsupported)"]
        raise ValueError(f"Unsupported: unresolved named dataset reference {data['name']!r}")
    if ignore_unsupported:
        return [f"{var_name} = pd.DataFrame()  # vl2matplotlib: unsupported data source (ignore_unsupported)"]
    raise ValueError("Unsupported: data source has none of values/url/name")


def render_temporal_coercion(var_name: str, fields: list[str]) -> list[str]:
    """`pd.to_datetime()` every temporal field once, up front -- every
    downstream `.dt` accessor / comparison / timeUnit derivation assumes a
    real `pd.Timestamp` column, not a raw JSON string. Guarded on the
    column actually existing yet: `_collect_temporal_fields()` already
    excludes a transform's own *named* output (`as`), but a `pivot`
    transform's own output columns are literally the runtime *values* of
    its pivot field -- unknowable at translation time -- so an encoding
    channel reading one of those (the common case: a `repeat: {layer:
    [...]}` template whose own repeat values happen to be exactly the
    columns a preceding `pivot` step will produce, e.g.
    `line_color_halo.vl.json`) would otherwise still reach this coercion
    before the transform that creates it has run at all, `KeyError`. This
    guard makes that a no-op instead of a crash; the field still ends up
    coerced downstream if/when it needs to be (a plain CSV/JSON numeric
    column already parses as a real dtype without help, and a `pivot`
    aggregate over an already-numeric `value` field is numeric already)."""
    if not fields:
        return []
    stmts = []
    for f in fields:
        stmts.append(
            f"if {f!r} in {var_name}.columns: {var_name}[{f!r}] = pd.to_datetime({var_name}[{f!r}], errors='coerce')"
        )
    return stmts


def render_quantitative_coercion(var_name: str, fields: list[str]) -> list[str]:
    """`pd.to_numeric()` every explicitly `quantitative`-typed field once,
    up front (see `translator.py`'s own `_collect_quantitative_fields()`)
    -- a real value already numeric passes through unchanged, so this is
    only ever a no-op for the common case and a genuine fix for the rarer
    one (a numeric-looking field whose raw JSON values are strings).
    Guarded on the column existing yet -- see `render_temporal_coercion()`'s
    identical guard and its docstring for why (a `pivot` transform's own
    output columns can't be known by name at translation time)."""
    if not fields:
        return []
    stmts = []
    for f in fields:
        stmts.append(
            f"if {f!r} in {var_name}.columns: {var_name}[{f!r}] = pd.to_numeric({var_name}[{f!r}], errors='coerce')"
        )
    return stmts
