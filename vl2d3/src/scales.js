// Resolve a Vega-Lite encoding channel definition (already rewritten by
// prepare.js so `aggregate`/`bin`/`timeUnit` are gone and `field` just names
// a plain column) into a D3 scale declaration.

import {formatValue} from './literals.js';

const SCHEME_ORDINAL = {
  tableau10: 'schemeTableau10',
  category10: 'schemeCategory10',
  accent: 'schemeAccent',
  dark2: 'schemeDark2',
  paired: 'schemePaired',
  set1: 'schemeSet1',
  set2: 'schemeSet2',
  set3: 'schemeSet3',
};

const SCHEME_SEQUENTIAL = {
  blues: 'interpolateBlues',
  greens: 'interpolateGreens',
  greys: 'interpolateGreys',
  oranges: 'interpolateOranges',
  purples: 'interpolatePurples',
  reds: 'interpolateReds',
  viridis: 'interpolateViridis',
  inferno: 'interpolateInferno',
  magma: 'interpolateMagma',
  plasma: 'interpolatePlasma',
  turbo: 'interpolateTurbo',
  warm: 'interpolateWarm',
  cool: 'interpolateCool',
  rainbow: 'interpolateRainbow',
};

// Vega-Lite's `scale.domain` is usually a plain array, but can also be one
// of several special reference forms (`"unionWith"`, a `DateTime` object
// domain, a `"param"`-driven domain, `"domainMin"/"domainMax"` siblings,
// ...). Only the plain-array form is supported; anything else throws
// rather than being silently (and incorrectly) treated as a literal array.
function explicitDomainCode(def) {
  const domain = def.scale && def.scale.domain;
  if (domain === undefined) return null;
  if (!Array.isArray(domain)) {
    throw new Error(`Unsupported scale domain form: ${JSON.stringify(domain)} (only a plain array is supported)`);
  }
  return formatValue(domain);
}

function domainFromData(dataVar, field, isTemporal) {
  const acc = `d => d[${JSON.stringify(field)}]`;
  return `d3.extent(${dataVar}, ${acc})`;
}

function zeroDomainFromData(dataVar, field) {
  const acc = `d => d[${JSON.stringify(field)}]`;
  return `[Math.min(0, d3.min(${dataVar}, ${acc})), Math.max(0, d3.max(${dataVar}, ${acc}))]`;
}

function ordinalDomainFromData(dataVar, field, sort) {
  const acc = `d => d[${JSON.stringify(field)}]`;
  const base = `Array.from(new Set(${dataVar}.map(${acc})))`;
  if (sort === 'descending') return `${base}.sort((a, b) => d3.descending(a, b))`;
  if (sort === null || sort === false) return base;
  return `${base}.sort((a, b) => d3.ascending(a, b))`;
}

// Resolve the position scale for `x` or `y`. `zeroBaseline` should be true
// when this is the "value" axis of a bar/area mark (Vega-Lite's default of
// including zero in that case).
export function resolvePositionScale(channel, def, {dataVar, rangeExpr, zeroBaseline}) {
  const varName = channel;
  const field = def.field;
  const explicitDomain = explicitDomainCode(def);
  const scaleType = def.scale && def.scale.type;

  if (def.type === 'temporal') {
    const domain = explicitDomain ?? domainFromData(dataVar, field);
    return {
      varName,
      decl: `const ${varName} = d3.scaleTime(${domain}, ${rangeExpr});`,
      kind: 'continuous',
    };
  }

  if (def.type === 'ordinal' || def.type === 'nominal') {
    const domain = explicitDomain ?? ordinalDomainFromData(dataVar, field, def.sort);
    const isBand = scaleType !== 'point';
    const ctor = isBand ? 'scaleBand' : 'scalePoint';
    const padding = isBand ? '.padding(0.1)' : '.padding(0.5)';
    return {
      varName,
      decl: `const ${varName} = d3.${ctor}(${domain}, ${rangeExpr})${padding};`,
      kind: isBand ? 'band' : 'point',
    };
  }

  // quantitative (default)
  const domain = explicitDomain ?? (zeroBaseline ? zeroDomainFromData(dataVar, field) : domainFromData(dataVar, field));
  const ctor = {log: 'scaleLog', pow: 'scalePow', sqrt: 'scaleSqrt', symlog: 'scaleSymlog'}[scaleType] || 'scaleLinear';
  const nice = explicitDomain ? '' : '.nice()';
  return {
    varName,
    decl: `const ${varName} = d3.${ctor}(${domain}, ${rangeExpr})${nice};`,
    kind: 'continuous',
  };
}

export function resolveColorScale(def, {dataVar}) {
  const field = def.field;
  const explicitDomain = explicitDomainCode(def);
  const scheme = def.scale && def.scale.scheme;

  if (def.type === 'quantitative' || def.type === 'temporal') {
    const domain = explicitDomain ?? domainFromData(dataVar, field);
    const interp = SCHEME_SEQUENTIAL[scheme] || 'interpolateBlues';
    return {
      varName: 'color',
      decl: `const color = d3.scaleSequential(${domain}, d3.${interp});`,
      kind: 'sequential',
    };
  }
  const domain = explicitDomain ?? ordinalDomainFromData(dataVar, field, def.sort);
  const range = def.scale && def.scale.range ? formatValue(def.scale.range) : `d3.${SCHEME_ORDINAL[scheme] || 'schemeTableau10'}`;
  return {
    varName: 'color',
    decl: `const color = d3.scaleOrdinal(${domain}, ${range});`,
    kind: 'ordinal',
  };
}

export function resolveSizeScale(def, {dataVar}) {
  const field = def.field;
  const explicitDomain = explicitDomainCode(def);
  const domain = explicitDomain ?? domainFromData(dataVar, field);
  const range = def.scale && def.scale.range ? formatValue(def.scale.range) : '[2, 20]';
  return {
    varName: 'size',
    decl: `const size = d3.scaleSqrt(${domain}, ${range});`,
    kind: 'continuous',
  };
}

export function resolveOpacityScale(def, {dataVar}) {
  const field = def.field;
  const explicitDomain = explicitDomainCode(def);
  const domain = explicitDomain ?? domainFromData(dataVar, field);
  const range = def.scale && def.scale.range ? formatValue(def.scale.range) : '[0.1, 1]';
  return {
    varName: 'opacity',
    decl: `const opacity = d3.scaleLinear(${domain}, ${range});`,
    kind: 'continuous',
  };
}
