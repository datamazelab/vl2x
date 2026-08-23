// Vega-Lite implicitly stacks a bar/area mark's aggregated position channel
// whenever a color/detail/opacity channel is also present (unless the
// position channel's own `stack` is explicitly disabled, or that axis is
// already being dodged via xOffset/yOffset) -- this is a real, mandatory
// part of the default appearance of the single most common chart shape in
// the corpus ("bar chart broken down by color"), not an optional nicety.
// D3 has no such built-in behavior, so this computes the stacked baseline
// (and, for "normalize"/"center", the rescaled top) as an explicit extra
// data-prep pass, then folds the result back into the *same* `y2`/`x2`
// range-channel mechanism marks.js already uses for any other ranged
// bar/area (a pre-binned Gantt-style range, an explicit x2/y2 box, ...) --
// so marks.js itself needs no stacking-specific code at all.

const STACKABLE_MARKS = ['bar', 'area'];
const GROUP_CHANNELS = ['color', 'detail', 'opacity'];

function markTypeOf(mark) {
  return typeof mark === 'string' ? mark : mark && mark.type;
}

// Decide whether (and how) a unit/layer child's mark+encoding should be
// stacked, per Vega-Lite's own "should this be stacked" rule -- returns
// null when it doesn't apply (no groupby channel, an explicit `stack:
// null`/`false`, or a dodge already claiming that axis), or a plan
// describing which axis/field to rewrite.
export function planStacking(mark, encoding) {
  const markType = markTypeOf(mark);
  if (!STACKABLE_MARKS.includes(markType)) return null;
  const groupChannel = GROUP_CHANNELS.find(ch => encoding[ch] && encoding[ch].field);
  if (!groupChannel) return null;

  for (const [posChannel, categoryChannel] of [
    ['y', 'x'],
    ['x', 'y'],
  ]) {
    const posDef = encoding[posChannel];
    const categoryDef = encoding[categoryChannel];
    if (!posDef || !posDef.field || posDef.type !== 'quantitative') continue;
    if (posDef.stack === null || posDef.stack === false) continue;
    // An explicit x2/y2 on the value axis is already a fully-specified
    // range (e.g. a `stack` *transform*'s own precomputed start/end, as
    // opposed to the implicit per-mark stacking this function handles) --
    // synthesizing a second stack on top of that would silently overwrite
    // a genuine, already-correct range with a wrong one.
    if (encoding[`${posChannel}2`]) continue;
    if (!categoryDef || !categoryDef.field) continue;
    // Dodging happens along the *category* axis (e.g. `xOffset` spreads
    // bars apart within their shared x position) -- not the value axis
    // being (potentially) stacked, which has no offset channel of its own.
    const offsetChannel = categoryChannel === 'x' ? 'xOffset' : 'yOffset';
    if (encoding[offsetChannel] && encoding[offsetChannel].field) continue;
    const mode = posDef.stack === 'normalize' ? 'normalize' : posDef.stack === 'center' ? 'center' : 'zero';
    return {posChannel, categoryField: categoryDef.field, groupField: encoding[groupChannel].field, valueField: posDef.field, mode};
  }
  return null;
}

// Group rows by the category field, cumulatively sum the value field
// within each group (sorted by the group/color field, a reasonable
// default stack order absent a dedicated `order` channel -- not
// necessarily Vega-Lite's own exact default order, but the resulting
// stack totals/heights are correct regardless of layer order), and attach
// a baseline+top pair of new fields per row.
export function renderStackingStatements(dataVar, plan) {
  const {categoryField, groupField, valueField, mode} = plan;
  const stack0 = `${valueField}_stack0`;
  const stack1 = `${valueField}_stack1`;
  const scaleLine =
    mode === 'normalize'
      ? `      return {...d, ${JSON.stringify(stack0)}: total ? y0 / total : 0, ${JSON.stringify(stack1)}: total ? y1 / total : 0};`
      : mode === 'center'
        ? `      return {...d, ${JSON.stringify(stack0)}: y0 - total / 2, ${JSON.stringify(stack1)}: y1 - total / 2};`
        : `      return {...d, ${JSON.stringify(stack0)}: y0, ${JSON.stringify(stack1)}: y1};`;
  return [
    `${dataVar} = Array.from(d3.group(${dataVar}, d => d[${JSON.stringify(categoryField)}]), ([, rows]) => {`,
    `    rows = rows.slice().sort((a, b) => d3.ascending(a[${JSON.stringify(groupField)}], b[${JSON.stringify(groupField)}]));`,
    `    const total = d3.sum(rows, d => d[${JSON.stringify(valueField)}]);`,
    `    let acc = 0;`,
    `    return rows.map(d => {`,
    `      const y0 = acc;`,
    // d3.sum() above already coerces non-numeric (e.g. string) field values
    // via its own internal `+value` -- this manual running total needs the
    // same coercion, or a string-valued field silently turns `+=` into
    // string concatenation ("0" + "0.14" + "0.6" -> "00.140.6", not 0.74).
    `      acc += +d[${JSON.stringify(valueField)}];`,
    `      const y1 = acc;`,
    scaleLine,
    `    });`,
    `  }).flat();`,
  ];
}

// Rewrite the mark's own encoding so the position channel points at the
// stacked *top* and a new `x2`/`y2` points at the stacked baseline --
// exactly the shape marks.js's renderBar()/renderArea() already draw a
// real ranged box/area from, for any other reason a spec might have one.
export function applyStackingToEncoding(encoding, plan) {
  const {posChannel, valueField} = plan;
  const posDef = encoding[posChannel];
  return {
    ...encoding,
    [posChannel]: {...posDef, field: `${valueField}_stack1`},
    [`${posChannel}2`]: {field: `${valueField}_stack0`, type: 'quantitative'},
  };
}
