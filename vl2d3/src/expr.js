// Best-effort translation of a Vega expression string into plain
// JavaScript operating on a row variable (default `d`).
//
// Vega expressions are close enough to JavaScript for common cases
// (comparisons, arithmetic, boolean logic, ternaries) that the practical
// approach is a token-level rewrite rather than a full parser: replace the
// `datum` binding with the row variable, map the small set of Vega
// expression built-ins that don't already exist as JS globals onto their JS
// equivalent, and pass everything else through verbatim. This covers the
// vast majority of real-world filter/calculate expressions. Anything else
// (`datetime()`, `toDate()`, the `vlSelectionTest` family, custom signal
// references, string functions like `toString`/`isValid`/`length`, ...)
// passes through as literal (invalid-in-plain-JS) text, which will throw a
// clear ReferenceError at chart-render time rather than silently producing
// wrong output.

const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

// Vega expression functions that are plain global functions there but live
// under `Math.` in JS.
const MATH_FUNCS = new Set([
  'abs', 'ceil', 'floor', 'round', 'sqrt', 'pow', 'log', 'exp', 'min', 'max',
  'random', 'sign', 'cbrt', 'hypot', 'log2', 'log10', 'atan2', 'atan', 'cos',
  'sin', 'tan', 'trunc',
]);

// Vega expression date-component accessors, mapped to the `Date` method they
// correspond to. Applied only to a single, simple (no nested parens)
// argument -- e.g. `year(datum.date)` -> `(d.date).getFullYear()`. Const-ants
// like `MS_PER_DAY` or expressions the function is called on with nested
// parens are left alone (better to fail loudly on a ReferenceError than
// mistranslate silently).
const DATE_FUNCS = {
  year: 'getFullYear', month: 'getMonth', date: 'getDate', day: 'getDay',
  hours: 'getHours', minutes: 'getMinutes', seconds: 'getSeconds',
  milliseconds: 'getMilliseconds', time: 'getTime',
  utcyear: 'getUTCFullYear', utcmonth: 'getUTCMonth', utcdate: 'getUTCDate',
  utcday: 'getUTCDay', utchours: 'getUTCHours', utcminutes: 'getUTCMinutes',
  utcseconds: 'getUTCSeconds', utcmilliseconds: 'getUTCMilliseconds',
};
// Vega expressions, unlike JS, tolerate whitespace between a function name
// and its opening paren (e.g. `ceil (x)`), so both function-call detectors
// below allow for it.
const DATE_FUNC_RE = new RegExp(`\\b(${Object.keys(DATE_FUNCS).join('|')})\\s*\\(([^()]+)\\)`, 'g');

// Find the outermost `if(` call in `s` (the identifier "if" immediately
// followed by "(", not part of a longer identifier), returning the
// character positions of its own "(" and matching ")", or null if absent.
function findIfCall(s) {
  const m = /(^|[^A-Za-z0-9_$])if\(/.exec(s);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  let inQuote = false;
  let quoteChar = '';
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === quoteChar) inQuote = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return {open, close: i};
    }
  }
  return null;
}

// Split `s` at top-level commas (respecting nested parens/quotes).
function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let inQuote = false;
  let quoteChar = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === quoteChar) inQuote = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === '(' || ch === '[') {
      depth++;
    } else if (ch === ')' || ch === ']') {
      depth--;
    } else if (ch === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

// Vega expressions can spell a conditional as the function `if(cond, a, b)`
// as well as the `cond ? a : b` ternary (already valid JS as-is) -- the
// function form isn't, so rewrite it into a real JS ternary. Recurses into
// each extracted argument since the else-branch commonly nests another
// `if(...)` call (a multi-way categorical mapping).
function rewriteIfCalls(s) {
  const call = findIfCall(s);
  if (!call) return s;
  const inner = s.slice(call.open + 1, call.close);
  const parts = splitTopLevel(inner);
  if (parts.length !== 3) return s; // malformed; leave as-is rather than guess
  const [cond, then, els] = parts.map(p => p.trim());
  const replacement = `(${cond} ? ${rewriteIfCalls(then)} : ${rewriteIfCalls(els)})`;
  const rewritten = s.slice(0, call.open - 2) + replacement + s.slice(call.close + 1);
  // Sibling `if(...)` calls (not nested inside this one, e.g. several
  // added together: `if(a,1,0) + if(b,1,0)`) still remain in the tail of
  // the string after this replacement -- keep scanning until none are left.
  return rewriteIfCalls(rewritten);
}

export function translateExpr(expr, rowVar = 'd') {
  if (typeof expr !== 'string') return expr;
  let out = expr.replace(DATE_FUNC_RE, (_, fn, arg) => `(${arg}).${DATE_FUNCS[fn]}()`);
  out = out.replace(IDENTIFIER_RE, (token, offset, str) => {
    if (token === 'datum') return rowVar;
    const isCall = /^\s*\(/.test(str.slice(offset + token.length));
    if (isCall && MATH_FUNCS.has(token)) return `Math.${token}`;
    if (isCall && token === 'now') return 'Date.now';
    return token;
  });
  out = rewriteIfCalls(out);
  return out;
}

const DATE_FUNC_FIELD_RE = new RegExp(
  `\\b(?:${Object.keys(DATE_FUNCS).join('|')})\\s*\\(\\s*datum\\.([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\)`,
  'g'
);

// Find fields that a `calculate` expression applies a date-component
// function to directly (e.g. `year(datum.Year)`) -- these need the same
// string-to-Date coercion as an explicitly temporal-typed encoding field,
// even though no encoding channel names them as temporal.
export function extractDateFunctionFields(expr) {
  if (typeof expr !== 'string') return [];
  return [...expr.matchAll(DATE_FUNC_FIELD_RE)].map(m => m[1]);
}

// Vega-Lite's non-expression-string filter forms: a field predicate object
// (`{field, equal/range/oneOf/lt/lte/gt/gte/valid}`), a logical
// composition (`{and/or/not: [...]}`), or a lookup/param predicate.
// Returns a JS boolean expression string operating on `rowVar`.
export function filterToExpr(filter, rowVar = 'd', ignoreUnsupported = false) {
  if (typeof filter === 'string') return translateExpr(filter, rowVar);

  if (Array.isArray(filter)) {
    if (ignoreUnsupported) return 'true /* vl2d3: unsupported bare-array filter, keeping every row (--ignore-unsupported) */';
    throw new Error('Unsupported filter: bare array (expected object or expression string)');
  }

  if (filter && typeof filter === 'object') {
    if ('and' in filter) return filter.and.map(f => `(${filterToExpr(f, rowVar, ignoreUnsupported)})`).join(' && ');
    if ('or' in filter) return filter.or.map(f => `(${filterToExpr(f, rowVar, ignoreUnsupported)})`).join(' || ');
    if ('not' in filter) return `!(${filterToExpr(filter.not, rowVar, ignoreUnsupported)})`;

    if ('field' in filter) {
      const ref = `${rowVar}[${JSON.stringify(filter.field)}]`;
      if ('equal' in filter) return `${ref} === ${JSON.stringify(filter.equal)}`;
      if ('lt' in filter) return `${ref} < ${JSON.stringify(filter.lt)}`;
      if ('lte' in filter) return `${ref} <= ${JSON.stringify(filter.lte)}`;
      if ('gt' in filter) return `${ref} > ${JSON.stringify(filter.gt)}`;
      if ('gte' in filter) return `${ref} >= ${JSON.stringify(filter.gte)}`;
      if ('range' in filter) {
        const [lo, hi] = filter.range;
        const parts = [];
        if (lo !== null && lo !== undefined) parts.push(`${ref} >= ${JSON.stringify(lo)}`);
        if (hi !== null && hi !== undefined) parts.push(`${ref} <= ${JSON.stringify(hi)}`);
        return parts.join(' && ') || 'true';
      }
      if ('oneOf' in filter || 'in' in filter) {
        const values = filter.oneOf || filter.in;
        return `${JSON.stringify(values)}.includes(${ref})`;
      }
      if ('valid' in filter) {
        return filter.valid ? `${ref} != null && !Number.isNaN(${ref})` : `${ref} == null || Number.isNaN(${ref})`;
      }
    }
  }

  if (ignoreUnsupported) {
    // A param/selection-driven predicate (e.g. `{"param": "brush"}`) has no
    // meaning without live interactivity (not implemented) -- "true" (keep
    // every row, as if nothing were selected/brushed) is the closest
    // reasonable default to a static render.
    const shape = JSON.stringify(filter).replace(/\*\//g, '* /');
    return `true /* vl2d3: unsupported filter predicate shape ${shape}, keeping every row (--ignore-unsupported) */`;
  }
  throw new Error(`Unsupported filter predicate shape: ${JSON.stringify(filter)}`);
}