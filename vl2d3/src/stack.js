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
  let groupChannel = GROUP_CHANNELS.find(ch => encoding[ch] && encoding[ch].field);
  // A color/detail/opacity field that's the *same* field already driving
  // an xOffset/yOffset dodge (e.g. bar_binned_yearmonth_grouped.vl.json's
  // own `xOffset: {field: "symbol"}` + `color: {field: "symbol"}`, plain
  // dodged-and-colored bars, not a further breakdown) isn't a second,
  // independent grouping to stack by -- the dodge already fully expresses
  // that one dimension, and every dodge slot then has exactly one row, so
  // "stacking" it is a no-op at best and, since a temporal/continuous x
  // axis has no band to dodge sub-positions within in the first place
  // (unlike the nominal/ordinal case), a broken loss of the dodge
  // positioning entirely at worst -- distinct from
  // bar_grouped_stacked.vl.json's own genuine "dodge by Origin, stack by
  // year within each Origin's slot", where the two fields differ.
  if (groupChannel) {
    const groupField = encoding[groupChannel].field;
    const offsetSharesField = ['xOffset', 'yOffset'].some(
      ch => encoding[ch] && encoding[ch].field === groupField
    );
    if (offsetSharesField) groupChannel = undefined;
  }
  // `stack: true`/`"zero"`/`"normalize"`/`"center"` explicitly requested on
  // the position channel itself still stacks even with no color/detail/
  // opacity groupby at all (e.g. bar_multi_values_per_categories.vl.json's
  // own several same-`a`-category rows, distinguished only by a literal
  // `fill`/`stroke` -- each row is its own implicit stack member, kept in
  // the data's own given order below since there's no group *field* to
  // align/densify sparse categories by).
  const explicitStack = ['x', 'y'].some(ch => {
    const def = encoding[ch];
    return def && (def.stack === true || def.stack === 'zero' || def.stack === 'normalize' || def.stack === 'center');
  });
  if (!groupChannel && !explicitStack) return null;

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
    // Dodging (e.g. `xOffset`) and stacking compose, not conflict -- dodge
    // picks which category *slot* a group's bar sits in, stacking says how
    // that one slot's own bar draws its value range; a color/detail
    // groupby present alongside a dodge (e.g. bar_grouped_stacked.vl.json's
    // own `xOffset: {field: "Origin"}` + `color: {timeUnit: "year", ...}`)
    // means "dodge by Origin, then stack by year within each Origin's own
    // slot" -- both real, common, and independently controlled by
    // Vega-Lite. Previously excluded outright here, which -- since a later
    // row's own un-stacked bar is drawn zero-baselined directly on top of
    // an earlier row sharing the exact same dodge slot -- left only
    // whichever row happened to be drawn last actually visible per slot.
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
    // A dodge sharing the category axis (e.g. `xOffset: {field: "Origin"}`
    // alongside `x: {field: "Cylinders"}`) means each *(category, offset)*
    // pair is really its own independent stack, not one shared across every
    // dodge slot at a given category value -- folded into the stack's own
    // grouping key below (renderStackingStatements()) the same way a
    // category's own x2 companion already is.
    const offsetChannel = categoryChannel === 'x' ? 'xOffset' : 'yOffset';
    const offsetDef = encoding[offsetChannel];
    return {
      posChannel,
      categoryField: categoryDef.field,
      categoryField2: categoryDef2 && categoryDef2.field,
      offsetField: offsetDef && offsetDef.field,
      groupField: groupChannel ? encoding[groupChannel].field : null,
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
  const {categoryField, categoryField2, offsetField, groupField, valueField, mode} = plan;
  // A dodge sharing the category axis splits each category into several
  // independent dodge slots, each with its own independent stack -- the
  // group-by key below folds the offset field in alongside the category
  // whenever one is present, so bar_grouped_stacked.vl.json's own
  // `xOffset: {field: "Origin"}` stacks each Origin's own bar by year
  // separately, rather than summing every Origin present at a given
  // Cylinders value into one shared stack.
  const categoryKeyExpr = d =>
    offsetField
      ? `JSON.stringify([${d}[${JSON.stringify(categoryField)}], ${d}[${JSON.stringify(offsetField)}]])`
      : `${d}[${JSON.stringify(categoryField)}]`;
  const stack0 = `${valueField}_stack0`;
  const stack1 = `${valueField}_stack1`;
  const scaleLine =
    mode === 'normalize'
      ? `      return {...d, ${JSON.stringify(stack0)}: total ? y0 / total : 0, ${JSON.stringify(stack1)}: total ? y1 / total : 0};`
      : mode === 'center'
        ? `      return {...d, ${JSON.stringify(stack0)}: y0 - total / 2, ${JSON.stringify(stack1)}: y1 - total / 2};`
        : `      return {...d, ${JSON.stringify(stack0)}: y0, ${JSON.stringify(stack1)}: y1};`;
  // A "zero" stack keeps its own baseline for positive values separate
  // from negative ones (e.g. bar_diverging_stack_population_pyramid.vl
  // .json's own signed `signed_people` -- female rows negative, male rows
  // positive) -- a single running total across a mix of signs would walk
  // the *second* sign's own segment off from whatever the first sign's
  // cumulative total happened to reach, instead of it starting fresh at
  // 0 the way a real diverging stack does. `normalize`/`center` (which
  // rescale the *whole* stack's own total afterward) keep the plain single
  // running total -- less common with mixed-sign data in the first place,
  // and Vega-Lite's own diverging convention is specifically about the
  // "zero" baseline.
  const accDecl = mode === 'zero' ? '{ pos: 0, neg: 0 }' : '0';
  const accStep =
    mode === 'zero'
      ? `      const __v = +d[${JSON.stringify(valueField)}];\n` +
        `      const y0 = __v >= 0 ? acc.pos : acc.neg;\n` +
        `      if (__v >= 0) acc.pos += __v; else acc.neg += __v;\n` +
        `      const y1 = __v >= 0 ? acc.pos : acc.neg;`
      : `      const y0 = acc;\n` +
        `      acc += +d[${JSON.stringify(valueField)}];\n` +
        `      const y1 = acc;`;
  if (!groupField) {
    // No real group field (an explicit `stack: true` with no color/detail/
    // opacity channel, see planStacking()'s own comment) -- nothing to
    // densify or sort by, every row sharing a category is simply stacked
    // in the data's own given order.
    return [
      `${dataVar} = Array.from(d3.group(${dataVar}, d => ${categoryKeyExpr('d')}), ([, rows]) => {`,
      `    const total = d3.sum(rows, d => d[${JSON.stringify(valueField)}]);`,
      `    let acc = ${accDecl};`,
      `    return rows.map(d => {`,
      accStep,
      scaleLine,
      `    });`,
      `  }).flat();`,
    ];
  }
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
    `${dataVar} = Array.from(d3.group(${dataVar}, d => ${categoryKeyExpr('d')}), ([, rows]) => {`,
    `    rows = rows.slice().sort((a, b) => d3.ascending(a[${JSON.stringify(groupField)}], b[${JSON.stringify(groupField)}]));`,
    `    const total = d3.sum(rows, d => d[${JSON.stringify(valueField)}]);`,
    `    let acc = ${accDecl};`,
    `    return rows.map(d => {`,
    accStep,
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
