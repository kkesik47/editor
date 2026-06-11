/**
 * resolveScaleColors.ts
 *
 * Walks a Vega-Lite specification to find explicit color scales
 * (encoding.color.scale, encoding.fill.scale, encoding.stroke.scale),
 * then resolves each scale to a concrete array of CSS color strings.
 *
 * Handles three specification forms:
 *   1. scale.range  — a literal array of color strings
 *   2. scale.scheme — a string naming a Vega/D3 color scheme
 *   3. scale.scheme — an object { name, count?, extent? }
 *
 * Continuous/sequential schemes are sampled at evenly-spaced points.
 * The `count` and `extent` parameters are respected when present.
 *
 * ─── Domain-aware slicing for categorical scales ────────────────
 *
 * Vega-Lite assigns scheme colors to data categories one-by-one, in
 * domain order. A 2-category nominal field only uses the FIRST two
 * colors of a scheme like tableau10; the remaining 8 are never
 * rendered, so they shouldn't be subject to accessibility checks.
 *
 * For categorical scales we therefore try to determine the actual
 * domain size and slice the resolved color list accordingly. Sources
 * for the domain size, in priority order:
 *
 *   1. scale.domain  — explicit array, length is authoritative
 *   2. Data inspection — for nominal fields, count distinct values
 *      of the encoded field in spec.data.values
 *   3. Fallback — keep the full scheme (the safer default; better to
 *      false-positive than to miss real issues for unknown sources)
 *
 * For sequential / diverging scales we never slice. They are
 * sampled at fixed density (16 points) so the CVD analysis can
 * detect fold-over and other distant-pair problems consistently.
 */

import {scheme as vegaScheme} from 'vega-scale';

// ─── Public types ────────────────────────────────────────────────

/**
 * Three scale shapes, each with a different distinguishability model:
 *
 *   categorical → unordered categories; every pair must be distinct.
 *   sequential  → ordered low→high gradient; brightness must move
 *                 in one direction across the whole range.
 *   diverging   → ordered values around a neutral midpoint; brightness
 *                 is expected to form a V (or inverted V), so each half
 *                 must be checked independently.
 */
export type ScaleType = 'categorical' | 'sequential' | 'diverging';

/** One resolved color scale extracted from a Vega-Lite spec. */
export interface ResolvedScale {
  /** The concrete CSS color strings the scale will render. */
  colors: string[];
  /** Categorical / sequential / diverging — controls which checks apply. */
  scaleType: ScaleType;
  /** JSON Pointer to the scale property (for editor underlines). */
  jsonPointer: string;
  /** Which encoding channel: 'color', 'fill', or 'stroke'. */
  channel: string;
  /** The original scheme name, if the scale came from a named scheme. */
  schemeName?: string;
  /**
   * For categorical scales, the number of categories actually used by
   * the data (or the explicit domain length). Undefined when we
   * couldn't determine the count and kept the full scheme.
   */
  usedCategoryCount?: number;
}

// ─── Constants ───────────────────────────────────────────────────

/** Encoding channels that carry color information in Vega-Lite. */
const COLOR_CHANNELS = ['color', 'fill', 'stroke'] as const;

/**
 * How many evenly-spaced samples to take from a continuous color
 * interpolator when no explicit count is given.
 *
 * 16 gives good coverage: with a stride of floor(16/3) = 5,
 * stride-pair checks span ~31% of the scale range, reliably
 * catching fold-over problems like rainbow under CVD simulation.
 */
const DEFAULT_CONTINUOUS_SAMPLES = 16;

/**
 * Named Vega/D3 color schemes that are diverging (two-tailed around
 * a neutral midpoint).  Matched against the base name with any
 * numeric suffix stripped (e.g. "blueorange-7" → "blueorange").
 *
 * Source: https://vega.github.io/vega/docs/schemes/#diverging
 */
const DIVERGING_SCHEMES = new Set<string>([
  'blueorange',
  'brownbluegreen',
  'purplegreen',
  'pinkyellowgreen',
  'purpleorange',
  'redblue',
  'redgrey',
  'redyellowblue',
  'redyellowgreen',
  'spectral',
]);

/**
 * Whether a scheme name refers to a diverging palette.
 *
 * Strips any trailing "-N" (used for discrete variants like
 * "blueorange-7") before looking up the base name.
 */
function isDivergingScheme(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  const base = name.toLowerCase().replace(/-\d+$/, '');
  return DIVERGING_SCHEMES.has(base);
}

// ─── Scheme resolution ──────────────────────────────────────────

/** Options controlling how a named scheme is resolved to concrete colors. */
interface ResolveSchemeOptions {
  /** Categorical / sequential / diverging — decides the sampling strategy. */
  scaleType: ScaleType;
  /**
   * For categorical scales, how many categories the data actually uses.
   * Null when unknown (e.g. data loaded from a URL).
   */
  categoryCount: number | null;
  /** Explicit scheme `count` from the object form { name, count }, if any. */
  count?: number;
  /** Explicit scheme `extent` from the object form, if any. */
  extent?: [number, number];
}

/**
 * Resolve a named Vega/D3 color scheme to an array of CSS color strings.
 *
 * Continuous schemes (rainbow, viridis, …) are interpolator functions and
 * must be SAMPLED. How we sample depends on the scale type:
 *
 *   categorical → one color per category, sampled the way Vega assigns
 *                 colors to an ordinal/nominal scale. This is what makes
 *                 the resolved colors match the ones Vega actually renders.
 *   sequential  → dense, even sampling across the full range, so the CVD
 *   / diverging   analysis can detect fold-over between distant points.
 *
 * Discrete schemes (tableau10, …) are plain arrays; trimming them to the
 * used category count happens later, in maybeSliceCategorical.
 */
function resolveNamedScheme(
  name: string,
  opts: ResolveSchemeOptions,
): string[] | null {
  let schemeValue: unknown;

  try {
    schemeValue = vegaScheme(name);
  } catch {
    return null; // Scheme not registered
  }

  if (!schemeValue) {
    return null;
  }

  // Continuous scheme → interpolator function.
  if (typeof schemeValue === 'function') {
    const interpolator = schemeValue as (t: number) => string;

    // Categorical: pick exactly one color per category, matching the
    // Vega renderer. An explicit scheme.count takes precedence over the
    // category count we inferred from the data.
    const categoricalCount = opts.count ?? opts.categoryCount ?? null;
    if (opts.scaleType === 'categorical' && categoricalCount != null) {
      return sampleCategoricalInterpolator(interpolator, categoricalCount);
    }

    // Sequential / diverging (or categorical with unknown count):
    // dense, even sampling across the whole range.
    return sampleInterpolator(interpolator, opts.count, opts.extent);
  }

  // Discrete / categorical scheme → array
  if (Array.isArray(schemeValue)) {
    return resolveDiscreteScheme(schemeValue, opts.count);
  }

  return null;
}

function sampleInterpolator(
  interpolator: (t: number) => string,
  count?: number,
  extent?: [number, number],
): string[] {
  const n = count ?? DEFAULT_CONTINUOUS_SAMPLES;
  const [lo, hi] = extent ?? [0, 1];

  return Array.from({length: n}, (_, i) => {
    const t = n === 1 ? (lo + hi) / 2 : lo + (i / (n - 1)) * (hi - lo);
    return interpolator(t);
  });
}

/**
 * Sample a continuous interpolator the way Vega assigns colors to an
 * ordinal / nominal (categorical) scale: `count` colors taken at
 * t = (i + 1) / (count + 1).
 *
 * The crucial detail is that Vega skips the t = 0 and t = 1 endpoints, so
 * categorical colors never land on the extreme ends of a scheme — which
 * are often near-black or near-white, or (for the cyclical "rainbow"
 * scheme) the same purple at both ends. Reproducing this spacing is what
 * makes our resolved colors match the swatches Vega actually renders:
 * rainbow with 3 categories → coral / yellow-green / teal, NOT the
 * purple/magenta start of the scheme.
 *
 * Verified against vega-lite v6 for the rainbow and viridis schemes,
 * category counts 2–7.
 */
function sampleCategoricalInterpolator(
  interpolator: (t: number) => string,
  count: number,
): string[] {
  return Array.from({length: count}, (_, i) =>
    interpolator((i + 1) / (count + 1)),
  );
}

function resolveDiscreteScheme(schemeValue: unknown[], count?: number): string[] | null {
  // Flat array of color strings
  if (schemeValue.length > 0 && typeof schemeValue[0] === 'string') {
    const colors = schemeValue as string[];
    return count ? colors.slice(0, count) : colors;
  }

  // Array of arrays indexed by count
  if (count && Array.isArray(schemeValue[count])) {
    return schemeValue[count] as string[];
  }

  // Fall back to the largest available sub-array
  for (let i = schemeValue.length - 1; i >= 0; i--) {
    if (Array.isArray(schemeValue[i]) && (schemeValue[i] as unknown[]).length > 0) {
      return schemeValue[i] as string[];
    }
  }

  return null;
}

// ─── Domain-size inference (categorical only) ───────────────────

/**
 * Determine how many distinct categories the data actually contains
 * for the given encoding channel.
 *
 * Priority:
 *   1. scale.domain    — explicit array of category labels.
 *   2. Inline data     — count distinct values of channelDef.field
 *                        in spec.data.values.
 *
 * Returns null when the domain size cannot be reliably determined
 * (data is loaded from a URL, the field isn't named, etc.). Callers
 * should keep the full scheme in that case.
 */
function resolveCategoryCount(
  spec: Record<string, unknown>,
  channelDef: Record<string, unknown>,
): number | null {
  // 1. Explicit scale.domain
  const scale = channelDef.scale as Record<string, unknown> | undefined;
  if (Array.isArray(scale?.domain)) {
    return (scale!.domain as unknown[]).length;
  }

  // 2. Inline data — count distinct values of the encoded field
  const fieldName = channelDef.field;
  if (typeof fieldName !== 'string') return null;

  const data = spec.data as Record<string, unknown> | undefined;
  const values = data?.values;
  if (!Array.isArray(values)) return null;

  const seen = new Set<unknown>();
  for (const row of values) {
    if (row && typeof row === 'object') {
      const v = (row as Record<string, unknown>)[fieldName];
      if (v !== undefined) seen.add(v);
    }
  }

  return seen.size > 0 ? seen.size : null;
}

// ─── Scale type inference ────────────────────────────────────────

function inferScaleType(encodingDef: Record<string, unknown>): ScaleType {
  const fieldType = encodingDef?.type;

  // Nominal fields are always categorical — even with a diverging palette,
  // the individual categories are unordered and need pairwise checks.
  if (fieldType === 'nominal') return 'categorical';

  const scale = encodingDef?.scale as Record<string, unknown> | undefined;

  if (scale) {
    if (scale.type === 'diverging') return 'diverging';

    if (Array.isArray(scale.domain) && scale.domain.length === 3) {
      return 'diverging';
    }

    if (scale.domainMid != null) return 'diverging';

    const schemeName =
      typeof scale.scheme === 'string'
        ? scale.scheme
        : (scale.scheme as Record<string, unknown> | undefined)?.name;
    if (isDivergingScheme(schemeName)) return 'diverging';
  }

  if (fieldType === 'ordinal') return 'sequential';
  if (fieldType === 'quantitative') return 'sequential';
  if (fieldType === 'temporal') return 'sequential';

  // Unknown or missing → default to categorical (stricter check)
  return 'categorical';
}

// ─── Slicing helper ──────────────────────────────────────────────

/**
 * For categorical scales, trim the resolved colors down to the actual
 * category count, given a precomputed count from resolveCategoryCount.
 *
 * Returns a tuple of [slicedColors, usedCategoryCount or undefined].
 *
 * Continuous schemes are already sampled to exactly `categoryCount`
 * colors (see resolveNamedScheme), so the slice below is a no-op for
 * them; it still trims discrete schemes and explicit ranges.
 *
 * Sequential / diverging scales are never sliced — see file header.
 */
function maybeSliceCategorical(
  scaleType: ScaleType,
  colors: string[],
  categoryCount: number | null,
): {colors: string[]; usedCategoryCount?: number} {
  if (scaleType !== 'categorical' || categoryCount == null) return {colors};

  // Don't expand: if the data has more categories than the palette,
  // Vega-Lite will recycle colors and the user already has bigger
  // problems than CVD safety. Leave as-is and let other rules speak.
  if (categoryCount >= colors.length) {
    return {colors, usedCategoryCount: categoryCount};
  }

  return {colors: colors.slice(0, categoryCount), usedCategoryCount: categoryCount};
}

// ─── Spec walker ─────────────────────────────────────────────────

function walkSpec(
  spec: Record<string, unknown>,
  node: unknown,
  pointer: string,
  results: ResolvedScale[],
): void {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    node.forEach((item, i) => walkSpec(spec, item, `${pointer}/${i}`, results));
    return;
  }

  const obj = node as Record<string, unknown>;

  // Check encoding at this level
  extractScalesFromEncoding(spec, obj, pointer, results);

  // Recurse into compositional properties
  const compositionKeys = ['layer', 'hconcat', 'vconcat', 'concat', 'spec'];
  for (const key of compositionKeys) {
    if (obj[key]) {
      walkSpec(spec, obj[key], `${pointer}/${key}`, results);
    }
  }
}

function extractScalesFromEncoding(
  spec: Record<string, unknown>,
  node: Record<string, unknown>,
  pointer: string,
  results: ResolvedScale[],
): void {
  const encoding = node?.encoding as Record<string, unknown> | undefined;
  if (!encoding || typeof encoding !== 'object') return;

  for (const channel of COLOR_CHANNELS) {
    const channelDef = encoding[channel] as Record<string, unknown> | undefined;
    if (!channelDef || typeof channelDef !== 'object') continue;

    // Direct: encoding.<channel> carries field/type/scale.
    extractFromChannelDef(
      spec,
      channelDef,
      `${pointer}/encoding/${channel}`,
      channel,
      results,
    );

    // Conditional encodings: encoding.<channel>.condition can carry
    // its OWN field/type/scale, and that's the scale Vega-Lite uses
    // for matched items. With the very common click/brush pattern
    // (default-empty selection ≡ "everything matches"), the
    // condition's scale is what actually paints the marks — so a
    // walker that ignores it misses contrast, CVD, lightness and
    // uniformity issues for those charts entirely.
    //
    // Two shapes to handle: a single condition object, or an array
    // of conditions (Vega-Lite allows both).
    const condition = channelDef.condition;
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      extractFromChannelDef(
        spec,
        condition as Record<string, unknown>,
        `${pointer}/encoding/${channel}/condition`,
        channel,
        results,
      );
    } else if (Array.isArray(condition)) {
      condition.forEach((c, i) => {
        if (c && typeof c === 'object') {
          extractFromChannelDef(
            spec,
            c as Record<string, unknown>,
            `${pointer}/encoding/${channel}/condition/${i}`,
            channel,
            results,
          );
        }
      });
    }
  }
}

/**
 * Extract a scale from one channelDef-shaped object — either the
 * channel itself or a `condition` block, both of which can carry
 * the same trio of `field` / `type` / `scale` properties.
 *
 * `baseChannelPointer` is the pointer at which the object lives in
 * the spec (e.g. `/encoding/color` or `/encoding/color/condition`);
 * the produced `jsonPointer` extends it with `/scale/range` or
 * `/scale/scheme` as appropriate.
 *
 * Mirrors the three-case structure the previous inline version used
 * (literal range; named scheme string; scheme object). Factored out
 * so the direct and conditional paths share one implementation.
 */
function extractFromChannelDef(
  spec: Record<string, unknown>,
  channelDef: Record<string, unknown>,
  baseChannelPointer: string,
  channel: string,
  results: ResolvedScale[],
): void {
  const scale = channelDef.scale as Record<string, unknown> | undefined;
  if (!scale || typeof scale !== 'object') return;

  const scaleType = inferScaleType(channelDef);
  const categoryCount =
    scaleType === 'categorical' ? resolveCategoryCount(spec, channelDef) : null;
  const basePointer = `${baseChannelPointer}/scale`;

  // ── Case 1: scale.range is a literal array of colors ──
  if (Array.isArray(scale.range)) {
    const colors = (scale.range as unknown[]).filter(
      (c): c is string => typeof c === 'string',
    );
    if (colors.length >= 2) {
      const sliced = maybeSliceCategorical(scaleType, colors, categoryCount);
      if (sliced.colors.length >= 2) {
        results.push({
          colors: sliced.colors,
          scaleType,
          jsonPointer: `${basePointer}/range`,
          channel,
          usedCategoryCount: sliced.usedCategoryCount,
        });
      }
    }
    return; // range takes priority over scheme
  }

  // ── Case 2: scale.scheme is a string ──
  if (typeof scale.scheme === 'string') {
    const colors = resolveNamedScheme(scale.scheme, {scaleType, categoryCount});
    if (colors && colors.length >= 2) {
      const sliced = maybeSliceCategorical(scaleType, colors, categoryCount);
      if (sliced.colors.length >= 2) {
        results.push({
          colors: sliced.colors,
          scaleType,
          jsonPointer: `${basePointer}/scheme`,
          channel,
          schemeName: scale.scheme,
          usedCategoryCount: sliced.usedCategoryCount,
        });
      }
    }
    return;
  }

  // ── Case 3: scale.scheme is an object { name, count?, extent? } ──
  if (
    scale.scheme &&
    typeof scale.scheme === 'object' &&
    !Array.isArray(scale.scheme)
  ) {
    const schemeObj = scale.scheme as Record<string, unknown>;
    const name = schemeObj.name;
    if (typeof name !== 'string') return;

    const count = typeof schemeObj.count === 'number' ? schemeObj.count : undefined;
    const extent =
      Array.isArray(schemeObj.extent) && schemeObj.extent.length === 2
        ? (schemeObj.extent as [number, number])
        : undefined;

    const colors = resolveNamedScheme(name, {scaleType, categoryCount, count, extent});
    if (colors && colors.length >= 2) {
      const sliced = maybeSliceCategorical(scaleType, colors, categoryCount);
      if (sliced.colors.length >= 2) {
        results.push({
          colors: sliced.colors,
          scaleType,
          jsonPointer: `${basePointer}/scheme`,
          channel,
          schemeName: name,
          usedCategoryCount: sliced.usedCategoryCount,
        });
      }
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Find all explicit color scales in a Vega-Lite specification and
 * resolve each to a concrete array of CSS color strings.
 *
 * Categorical scales are sliced to the actual number of categories
 * used by the data, so accessibility checks only consider colors
 * that will actually render.
 */
export function resolveScaleColors(spec: Record<string, unknown>): ResolvedScale[] {
  const results: ResolvedScale[] = [];
  walkSpec(spec, spec, '', results);
  return results;
}