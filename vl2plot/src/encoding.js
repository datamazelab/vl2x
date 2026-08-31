// Shared per-channel helpers: Vega-Lite's own implicit type inference
// (`effectiveType`), and turning a single (already `prepare.js`-rewritten,
// so `aggregate`/`bin`/`timeUnit` are gone and only a plain `field`/`value`/
// `datum` remains) encoding channel definition into the literal value Plot's
// own mark-options object expects for that channel -- a bare field-name
// *string* (Plot resolves it as a column accessor against the mark's own
// data array automatically) for a `field` reference, or a real JS literal
// for a `value`/`datum`.

import {formatValue} from './literals.js';
import {isCyclicTimeUnit} from './timeunit.js';

const DISCRETE_TYPES = new Set(['ordinal', 'nominal']);

// Mirrors `vl2matplotlib`'s own `scales.py::effective_type()` /
// `vl2d3`'s own equivalent: the channel's type as Vega-Lite itself would
// infer it when the spec omits an explicit `type` -- `aggregate`/`bin`
// imply quantitative; a *combined* `timeUnit` (year, yearmonth, ...) implies
// temporal, while a single *cyclic* one (month, day, quarter, hours, ...)
// reduces to a plain integer/cyclic value instead (see `timeunit.js`'s own
// `isCyclicTimeUnit()`), so it does NOT imply temporal here.
// A quantitative-only (or temporal-only) `scale.type` is a real signal
// too -- e.g. layer_line_window.vl.json's own `y: {field: "fps", scale:
// {type: "log"}}`, no explicit "type" at all: a log scale only ever
// applies to a quantitative field, so this can infer just as confidently
// as an explicit `type`. Missing this previously fed straight into
// orientation()'s own `isQuantitative(x) && !isQuantitative(y)` heuristic
// -- x (an explicitly quantitative "row" field) read as quantitative, y
// (this log-scaled "fps" field, no explicit type) read as NOT
// quantitative purely for lack of an explicit label, misclassifying an
// ordinary vertical line chart as "horizontal" and, via that, feeding the
// line's own default sort-by-domain-field fallback the WRONG field
// (`enc.y.field`, "fps", instead of `enc.x.field`, "row") -- silently
// connecting the line's points in ascending-fps order instead of trial
// order.
const QUANTITATIVE_ONLY_SCALE_TYPES = new Set(['linear', 'log', 'pow', 'sqrt', 'symlog']);
const TEMPORAL_ONLY_SCALE_TYPES = new Set(['time', 'utc']);

export function effectiveType(def) {
  if (!def || typeof def !== 'object') return null;
  if (def.type) return def.type;
  if (def.aggregate != null || def.bin) return 'quantitative';
  if (def.timeUnit) return isCyclicTimeUnit(def.timeUnit) ? 'quantitative' : 'temporal';
  const scaleType = def.scale && def.scale.type;
  if (QUANTITATIVE_ONLY_SCALE_TYPES.has(scaleType)) return 'quantitative';
  if (TEMPORAL_ONLY_SCALE_TYPES.has(scaleType)) return 'temporal';
  return null;
}

export function isQuantitative(def) {
  return effectiveType(def) === 'quantitative';
}

export function isDiscrete(def) {
  return DISCRETE_TYPES.has(effectiveType(def));
}

export function isTemporal(def) {
  return effectiveType(def) === 'temporal';
}

export function hasField(def) {
  return def && typeof def === 'object' && typeof def.field === 'string';
}

// A literal `value`/`datum` string is genuinely ambiguous to Plot itself
// -- it applies its own "does this look like a CSS color" heuristic to
// decide whether a bare string channel option is a literal or a column
// name to read, and (confirmed empirically) keeps applying that same
// heuristic even *inside* an explicit `{value: "..."}` wrapper, which one
// might otherwise expect to force literal treatment unconditionally. A
// string that happens to coincide with a real column name in the data
// (e.g. a `repeat`-substituted category label like `"a"`, coincidentally
// also a field name on that very row) is silently read as that column's
// own per-row value instead of the constant it was meant to be --
// splitting a single line into one broken segment per distinct value,
// not a crash. A function accessor (`() => "a"`) sidesteps the ambiguity
// entirely: Plot never applies the string-vs-column heuristic to a
// function's own return value, so this is always safe, for a literal
// that happens to look like a valid CSS color too.
export function literalChannelExpr(value) {
  if (typeof value !== 'string') return formatValue(value);
  return `() => ${formatValue(value)}`;
}

// The Plot mark-option *value* for one channel: a field-name string (for a
// real `field` reference -- Plot treats any string matching a data column
// as an accessor automatically), a JS literal (for `value`), or `null` when
// the channel has neither (caller should omit the key entirely in that
// case). `asCode` renders a literal `value`/`datum` as JS *source text*
// (ready to splice into a generated options object); non-code callers that
// just need the raw value can pass `asCode: false`.
export function channelValue(def, {asCode = true} = {}) {
  if (!def || typeof def !== 'object') return null;
  if (typeof def.field === 'string') return asCode ? formatValue(unescapeFieldName(def.field)) : unescapeFieldName(def.field);
  if ('value' in def) return asCode ? literalChannelExpr(def.value) : def.value;
  if ('datum' in def) return asCode ? literalChannelExpr(def.datum) : def.datum;
  return null;
}

// Escaped-dot / bracket field references (Vega-Lite's own convention for a
// field name that isn't a plain identifier path, e.g. `"a.b"` meaning the
// literal key `"a.b"`, vs. `a\\.b` meaning "escape this dot, it's part of
// the name not a nested-object path") -- `data.js`'s own inline-`values`
// loading step already flattens one level of real nested objects into
// dotted keys (`vlFlattenOneLevel()`, see `runtime.js`), so by the time
// this module sees a field name, a plain string key lookup is always
// correct; this only needs to strip Vega-Lite's own backslash-escape
// marker.
export function unescapeFieldName(field) {
  return typeof field === 'string' ? field.replace(/\\\./g, '.') : field;
}
