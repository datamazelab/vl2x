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
    // The category axis's own companion range (e.g. a binned x's `x2`,
    // repeat_histogram.vl.json's own `bin1_Horsepower`) -- distinct from
    // the value axis's `${posChannel}2` excluded above, and carried
    // through here (rather than left for renderStackingStatements() to
    // rediscover) so a densified/filled-in row (a category+group
    // combination with no real data, see renderStackingStatements()) can
    // still be given the right bin-end value instead of leaving it
    // `undefined` -- every OTHER row on that same category already has
    // the same bin1, since bin edges are a property of the category value
    // itself, not of which group happens to have data there.
    const categoryDef2 = encoding[`${categoryChannel}2`];
    return {
      posChannel,
      categoryField: categoryDef.field,
      categoryField2: categoryDef2 && categoryDef2.field,
      groupField: encoding[groupChannel].field,
      valueField: posDef.field,
      mode,
    };
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
  const {categoryField, categoryField2, groupField, valueField, mode} = plan;
  const stack0 = `${valueField}_stack0`;
  const stack1 = `${valueField}_stack1`;
  const scaleLine =
    mode === 'normalize'
      ? `      return {...d, ${JSON.stringify(stack0)}: total ? y0 / total : 0, ${JSON.stringify(stack1)}: total ? y1 / total : 0};`
      : mode === 'center'
        ? `      return {...d, ${JSON.stringify(stack0)}: y0 - total / 2, ${JSON.stringify(stack1)}: y1 - total / 2};`
        : `      return {...d, ${JSON.stringify(stack0)}: y0, ${JSON.stringify(stack1)}: y1};`;
  return [
    // Real-world grouped data is commonly *sparse*: not every (category,
    // group) combination actually has a row (e.g.
    // stacked_area_ordinal.vl.json's own `Cylinders` count didn't exist in
    // every single `Year`) -- stacking only the rows that happen to exist
    // for each category would then give that category fewer/differently-
    // ordered stack slots than its neighbors, and since each *group*'s own
    // area/bar is drawn as one continuous shape across every category it
    // has a row for, a neighboring category with one more/fewer group
    // present shifts that shape's baseline out from under its neighbor's
    // top edge -- a visibly broken, gapped stack instead of a smooth one.
    // Filled in with an explicit 0 for every category/group pair missing
    // one, before grouping+summing below, so every category always stacks
    // the exact same full set of groups (in the same sorted order).
    `${dataVar} = (() => {`,
    `  const __cats = Array.from(new d3.InternSet(${dataVar}.map(d => d[${JSON.stringify(categoryField)}])));`,
    `  const __groups = Array.from(new d3.InternSet(${dataVar}.map(d => d[${JSON.stringify(groupField)}])));`,
    `  const __present = new Set(${dataVar}.map(d => JSON.stringify([d[${JSON.stringify(categoryField)}], d[${JSON.stringify(groupField)}]])));`,
    // A filled row's own category-companion value (e.g. a binned x's own
    // `x2`) is looked up from any real row sharing that same category
    // value, rather than left unset -- every row on a given category
    // already has the same bin end regardless of which group it's for.
    ...(categoryField2
      ? [
          `  const __cat2 = new d3.InternMap(${dataVar}.map(d => [d[${JSON.stringify(categoryField)}], d[${JSON.stringify(categoryField2)}]]));`,
        ]
      : []),
    `  const __filled = [];`,
    `  for (const __c of __cats) for (const __g of __groups) if (!__present.has(JSON.stringify([__c, __g]))) __filled.push({${JSON.stringify(categoryField)}: __c, ${JSON.stringify(groupField)}: __g, ${JSON.stringify(valueField)}: 0${categoryField2 ? `, ${JSON.stringify(categoryField2)}: __cat2.get(__c)` : ''}});`,
    `  return [...${dataVar}, ...__filled];`,
    `})();`,
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
