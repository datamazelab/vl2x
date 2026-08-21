// Render plain JSON-compatible JavaScript values (as produced by JSON.parse)
// into JavaScript source text.

const MAX_LINE = 88;
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function renderKey(key) {
  return IDENTIFIER_RE.test(key) ? key : JSON.stringify(key);
}

function renderScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  return JSON.stringify(value);
}

// Try to render `value` as a single line; returns null if it contains
// something that can't be rendered inline (shouldn't normally happen).
function renderInline(value) {
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const parts = [];
    for (const k of keys) {
      const v = renderInline(value[k]);
      if (v === null) return null;
      parts.push(`${renderKey(k)}: ${v}`);
    }
    return `{${parts.join(', ')}}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const parts = [];
    for (const v of value) {
      const rv = renderInline(v);
      if (rv === null) return null;
      parts.push(rv);
    }
    return `[${parts.join(', ')}]`;
  }
  return renderScalar(value);
}

function renderMultiline(value, indent) {
  const pad = '  '.repeat(indent + 1);
  const closingPad = '  '.repeat(indent);

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const lines = keys.map(
      k => `${pad}${renderKey(k)}: ${formatValue(value[k], indent + 1)},`
    );
    return `{\n${lines.join('\n')}\n${closingPad}}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const lines = value.map(v => `${pad}${formatValue(v, indent + 1)},`);
    return `[\n${lines.join('\n')}\n${closingPad}]`;
  }
  return renderScalar(value);
}

// Render `value` as JavaScript source, pretty-printing across multiple
// lines when the single-line form would be too long.
export function formatValue(value, indent = 0) {
  const inline = renderInline(value);
  if (inline !== null && inline.length <= MAX_LINE - indent * 2 && !inline.includes('\n')) {
    return inline;
  }
  return renderMultiline(value, indent);
}
