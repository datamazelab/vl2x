// Helpers for building `base.method(args).method(args)...` fluent chains
// out of already-rendered argument expression strings.

const MAX_LINE = 88;

// Render `target(arg1, arg2, ...)` — single line if it fits, else one
// argument per line.
export function renderCall(target, argExprs) {
  const inline = `${target}(${argExprs.join(', ')})`;
  if (inline.length <= MAX_LINE && !inline.includes('\n')) return inline;
  const body = argExprs.map(a => indentBlock(a, 1)).join(',\n');
  return `${target}(\n${body}\n)`;
}

function indentBlock(text, level) {
  const pad = '  '.repeat(level);
  return text
    .split('\n')
    .map(line => pad + line)
    .join('\n');
}

// A fluent chain builder: start with a base expression, add `.method(args)`
// steps, and render the whole thing with one step per line once it no
// longer fits on a single line.
export class Chain {
  constructor(base) {
    this.base = base;
    this.steps = [];
  }

  call(method, argExprs = []) {
    this.steps.push(renderCall(`.${method}`, argExprs));
    return this;
  }

  toString() {
    const oneLine = this.base + this.steps.join('');
    if (this.steps.length <= 1 && oneLine.length <= MAX_LINE && !oneLine.includes('\n')) {
      return oneLine;
    }
    const lines = [this.base, ...this.steps.map(s => indentBlock(s, 1))];
    return lines.join('\n');
  }
}
