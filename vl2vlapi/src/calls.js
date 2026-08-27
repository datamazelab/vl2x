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
//
// `basePath`/`call(..., path)` are an opt-in JSON-path label (e.g.
// "encoding.x", "transform[0]") naming which part of the *input* spec each
// piece came from -- when `includeSourcePaths` is on and at least one is
// present, rendering is forced into the one-step-per-line form (a leading
// `// from: ...` comment can't share a line with anything after it) with a
// comment above the base and/or each labeled step. A `//` comment line
// followed by a line starting with `.method(...)` is valid JS either way --
// comments are whitespace to the parser, so the member-expression chain
// continues exactly as if the comment weren't there.
export class Chain {
  constructor(base, {basePath, includeSourcePaths = false} = {}) {
    this.base = base;
    this.basePath = basePath;
    this.includeSourcePaths = includeSourcePaths;
    this.steps = [];
  }

  call(method, argExprs = [], path) {
    this.steps.push({rendered: renderCall(`.${method}`, argExprs), path});
    return this;
  }

  toString() {
    const anyPath = this.includeSourcePaths && (this.basePath || this.steps.some(s => s.path));
    if (!anyPath) {
      const oneLine = this.base + this.steps.map(s => s.rendered).join('');
      if (this.steps.length <= 1 && oneLine.length <= MAX_LINE && !oneLine.includes('\n')) {
        return oneLine;
      }
      const lines = [this.base, ...this.steps.map(s => indentBlock(s.rendered, 1))];
      return lines.join('\n');
    }
    const lines = [];
    if (this.basePath) lines.push(`// from: ${this.basePath}`);
    lines.push(this.base);
    for (const step of this.steps) {
      if (step.path) lines.push(indentBlock(`// from: ${step.path}`, 1));
      lines.push(indentBlock(step.rendered, 1));
    }
    return lines.join('\n');
  }
}
