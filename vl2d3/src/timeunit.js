// Map a Vega-Lite `timeUnit` name to a JS expression that truncates/derives
// from a JS `Date` value. Assumes temporal fields have already been parsed
// into real `Date` objects (see data.js). Covers the common single time
// units; multi-part units (e.g. `yearmonth`, `yearmonthdate`) are built by
// combining the relevant components into a new `Date`, matching how
// Vega-Lite treats them as still-temporal (rather than the `utc*`/ordinal
// variants some units support -- those aren't specially handled here and
// fall back to the plain local-time unit of the same name).
//
// A single-component unit that doesn't include "year" (`month`, `date`,
// `quarter`, `hours`, `minutes`, `seconds`) is a *cyclic* bucket -- e.g.
// `month` alone means "which of the 12 months", collapsing every year in
// the data down to the same 12 buckets, not "the first of this month in
// this particular year". Every OTHER component of the resulting Date must
// therefore be pinned to the same constant for every row (not carried over
// from the real value), or rows from different years/months never
// collapse into the same bucket at all -- every row gets its own distinct,
// ever-increasing key, which both explodes an ordinal axis out to
// (effectively) one category per row instead of 12/31/24/etc, and --
// because that ever-increasing key still correlates with real elapsed
// time -- drags a second such axis along with it, producing a diagonal
// smear on a 2D grid (e.g. a calendar heatmap binning both "date" and
// "month") instead of a proper grid. `REF_YEAR` (a fixed, arbitrary leap
// year, matching Vega's own convention) is only needed so `date`'s Feb 29
// doesn't misbehave if this table is ever extended with a `monthdate`-style
// combo; here it's just a constant, since date/month/quarter's *own*
// non-extracted components are always fixed to Jan 1 regardless.
const REF_YEAR = 2012;

const local = {
  year: d => `new Date(${d}.getFullYear(), 0, 1)`,
  quarter: d => `new Date(${REF_YEAR}, Math.floor(${d}.getMonth() / 3) * 3, 1)`,
  month: d => `new Date(${REF_YEAR}, ${d}.getMonth(), 1)`,
  date: d => `new Date(${REF_YEAR}, 0, ${d}.getDate())`,
  day: d => `${d}.getDay()`,
  dayofyear: d => `Math.ceil((${d} - new Date(${d}.getFullYear(), 0, 0)) / 864e5)`,
  hours: d => `new Date(${REF_YEAR}, 0, 1, ${d}.getHours())`,
  minutes: d => `new Date(${REF_YEAR}, 0, 1, 0, ${d}.getMinutes())`,
  seconds: d => `new Date(${REF_YEAR}, 0, 1, 0, 0, ${d}.getSeconds())`,
  monthdate: d => `new Date(${REF_YEAR}, ${d}.getMonth(), ${d}.getDate())`,
  yearmonth: d => `new Date(${d}.getFullYear(), ${d}.getMonth(), 1)`,
  yearmonthdate: d => `new Date(${d}.getFullYear(), ${d}.getMonth(), ${d}.getDate())`,
  yearquarter: d => `new Date(${d}.getFullYear(), Math.floor(${d}.getMonth() / 3) * 3, 1)`,
};

// Strip a leading "utc" prefix -- treated the same as the local-time unit
// (a documented simplification: no timezone handling is performed). A
// leading "binned" prefix (e.g. "binnedyearmonth") marks a field Vega-Lite
// expects to already contain bucket-boundary values -- applying the same
// (idempotent, for genuinely pre-binned data) bucketing function as the
// unprefixed unit is a safe, simpler stand-in for tracking bin continuity
// specially.
//
// `unit` is usually a plain string, but Vega-Lite also allows a
// `TimeUnitParams` object (`{"unit": "year", "step": 2}`, used for
// e.g. binning into 2-year buckets). The `step`/other params are dropped --
// only the base unit is honored -- rather than failing outright.
function normalize(unit) {
  let name = typeof unit === 'object' && unit !== null ? unit.unit : unit;
  if (typeof name !== 'string') return name;
  // The two prefixes can appear in either order (e.g. "binnedutcyearmonthdate"
  // as well as a hypothetical "utcbinnedyearmonthdate") -- strip both,
  // repeating until neither matches, rather than only checking each once in
  // a fixed order (which would leave "binnedutc..." only half-stripped).
  let stripped = true;
  while (stripped) {
    stripped = false;
    if (name.startsWith('utc')) {
      name = name.slice(3);
      stripped = true;
    }
    if (name.startsWith('binned')) {
      name = name.slice(6);
      stripped = true;
    }
  }
  return name;
}

export function isSupportedTimeUnit(unit) {
  return normalize(unit) in local;
}

export function timeUnitExpr(unit, dateExpr, ignoreUnsupported = false) {
  const key = normalize(unit);
  const fn = local[key];
  if (!fn) {
    // No bucketing/truncation applied -- the real (un-truncated) date is
    // still a usable temporal value, just not grouped the way this unit
    // asked for.
    if (ignoreUnsupported) return `(${dateExpr}) /* vl2d3: unsupported timeUnit "${JSON.stringify(unit)}", left untruncated (--ignore-unsupported) */`;
    throw new Error(`Unsupported timeUnit: "${unit}"`);
  }
  return fn(dateExpr);
}

// A single-part timeUnit as a bare NUMBER (not a truncated Date) -- e.g.
// "year" -> the 4-digit year, "month" -> 1-12. Used only for a filter
// predicate comparing a timeUnit'd field against a plain scalar (as
// opposed to a DateTime object): Vega-Lite's own semantics for
// `{field, timeUnit: "year", equal: 2006}` compare just the extracted
// component number, not the full bucketed date, to the given value (a
// bucketed Date vs. a bare number is never meaningfully equal/ordered).
// `day`/`dayofyear` already return a number from `local` itself, so they're
// reused directly; a multi-part unit (yearmonth/yearmonthdate/yearquarter)
// has no single-number form and returns null (falls back to the
// bucketed-date comparison, which real specs practically never hit for
// these since they're normally compared against a DateTime object instead).
const componentUnits = {
  year: d => `${d}.getFullYear()`,
  quarter: d => `(Math.floor(${d}.getMonth() / 3) + 1)`,
  month: d => `(${d}.getMonth() + 1)`,
  date: d => `${d}.getDate()`,
  hours: d => `${d}.getHours()`,
  minutes: d => `${d}.getMinutes()`,
  seconds: d => `${d}.getSeconds()`,
};

export function timeUnitComponentExpr(unit, dateExpr) {
  const key = normalize(unit);
  if (key === 'day' || key === 'dayofyear') return local[key](dateExpr);
  const fn = componentUnits[key];
  return fn ? fn(dateExpr) : null;
}
