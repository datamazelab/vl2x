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
export function effectiveType(def) {
  if (!def || typeof def !== 'object') return null;
  if (def.type) return def.type;
  if (def.aggregate != null || def.bin) return 'quantitative';
  if (def.timeUnit) return isCyclicTimeUnit(def.timeUnit) ? 'quantitative' : 'temporal';
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
  if ('value' in def) return asCode ? formatValue(def.value) : def.value;
  if ('datum' in def) return asCode ? formatValue(def.datum) : def.datum;
  return null;
}

// Escaped-dot / bracket field references (Vega-Lite's own convention for a
// field name that isn't a plain identifier path, e.g. `"a.b"` meaning the
// literal key `"a.b"`, vs. `a\\.b` meaning "escape this dot, it's part of
// the name not a nested-object path") -- `prepare.js`'s own data-loading
// step already flattens one level of real nested objects into dotted keys
// (matching every other sibling's own convention), so by the time this
// module sees a field name, a plain string key lookup is always correct;
// this only needs to strip Vega-Lite's own backslash-escape marker.
export function unescapeFieldName(field) {
  return typeof field === 'string' ? field.replace(/\\\./g, '.') : field;
}
