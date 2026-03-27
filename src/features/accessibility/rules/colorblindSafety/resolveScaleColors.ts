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
 */

import {scheme as vegaScheme} from 'vega-scale';

// ─── Public types ────────────────────────────────────────────────

/** Whether the scale maps unordered categories or an ordered sequence. */
export type ScaleType = 'categorical' | 'sequential';

/** One resolved color scale extracted from a Vega-Lite spec. */
export interface ResolvedScale {
  /** The concrete CSS color strings the scale will render. */
  colors: string[];
  /** Categorical → check all pairs; sequential → check adjacent only. */
  scaleType: ScaleType;
  /** JSON Pointer to the scale property (for editor underlines). */
  jsonPointer: string;
  /** Which encoding channel: 'color', 'fill', or 'stroke'. */
  channel: string;
  /** The original scheme name, if the scale came from a named scheme. */
  schemeName?: string;
}

// ─── Constants ───────────────────────────────────────────────────

/** Encoding channels that carry color information in Vega-Lite. */
const COLOR_CHANNELS = ['color', 'fill', 'stroke'] as const;

/**
 * How many evenly-spaced samples to take from a continuous color
 * interpolator when no explicit count is given.
 *
 * 9 gives good coverage of the hue range without being excessive.
 */
const DEFAULT_CONTINUOUS_SAMPLES = 9;

// ─── Scheme resolution ──────────────────────────────────────────

/**
 * Resolve a named Vega/D3 color scheme to an array of hex strings.
 *
 * @param name   - The registered scheme name (e.g. 'viridis', 'tableau10').
 * @param count  - Optional number of colors to sample.
 * @param extent - Optional [min, max] range within 0–1 for continuous schemes.
 * @returns An array of CSS color strings, or null if the scheme is unknown.
 */
function resolveNamedScheme(
  name: string,
  count?: number,
  extent?: [number, number],
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

  // Continuous / sequential / diverging scheme → interpolator function
  if (typeof schemeValue === 'function') {
    return sampleInterpolator(schemeValue as (t: number) => string, count, extent);
  }

  // Discrete / categorical scheme → array
  if (Array.isArray(schemeValue)) {
    return resolveDiscreteScheme(schemeValue, count);
  }

  return null;
}

/**
 * Sample a continuous color interpolator at evenly-spaced points.
 */
function sampleInterpolator(
  interpolator: (t: number) => string,
  count?: number,
  extent?: [number, number],
): string[] {
  const n = count ?? DEFAULT_CONTINUOUS_SAMPLES;
  const [lo, hi] = extent ?? [0, 1];

  return Array.from({length: n}, (_, i) => {
    // For a single sample, take the midpoint of the range
    const t = n === 1 ? (lo + hi) / 2 : lo + (i / (n - 1)) * (hi - lo);
    return interpolator(t);
  });
}

/**
 * Resolve a discrete scheme value to a flat array of color strings.
 *
 * Vega's scheme registry stores discrete schemes in two forms:
 *   - A flat array of strings:  ['#4e79a7', '#f28e2b', ...]
 *   - An array of arrays indexed by count:  [undefined, ['#4e79a7'], ['#4e79a7', '#f28e2b'], ...]
 */
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

// ─── Scale type inference ────────────────────────────────────────

/**
 * Determine whether an encoding channel represents categories or a sequence.
 *
 * Vega-Lite's `type` field is the primary signal:
 *   - "nominal"                      → categorical (unordered)
 *   - "ordinal" / "quantitative" / "temporal" → sequential (ordered)
 *
 * When type is absent, we default to 'categorical' because the all-pairs
 * check is the safer (more conservative) approach.
 */
function inferScaleType(encodingDef: Record<string, unknown>): ScaleType {
  const fieldType = encodingDef?.type;

  if (fieldType === 'nominal') return 'categorical';
  if (fieldType === 'ordinal') return 'sequential';
  if (fieldType === 'quantitative') return 'sequential';
  if (fieldType === 'temporal') return 'sequential';

  // Unknown or missing → default to categorical (stricter check)
  return 'categorical';
}

// ─── Spec walker ─────────────────────────────────────────────────

/**
 * Walk a Vega-Lite spec tree and collect all explicit color scales.
 *
 * Handles nested compositions: layer, hconcat, vconcat, concat,
 * facet, and repeat specs all have their own encoding blocks.
 */
function walkSpec(node: unknown, pointer: string, results: ResolvedScale[]): void {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    node.forEach((item, i) => walkSpec(item, `${pointer}/${i}`, results));
    return;
  }

  const obj = node as Record<string, unknown>;

  // Check encoding at this level
  extractScalesFromEncoding(obj, pointer, results);

  // Recurse into compositional properties
  const compositionKeys = ['layer', 'hconcat', 'vconcat', 'concat', 'spec'];
  for (const key of compositionKeys) {
    if (obj[key]) {
      walkSpec(obj[key], `${pointer}/${key}`, results);
    }
  }
}

/**
 * Extract resolved color scales from the encoding block of a spec node.
 */
function extractScalesFromEncoding(
  node: Record<string, unknown>,
  pointer: string,
  results: ResolvedScale[],
): void {
  const encoding = node?.encoding as Record<string, unknown> | undefined;
  if (!encoding || typeof encoding !== 'object') return;

  for (const channel of COLOR_CHANNELS) {
    const channelDef = encoding[channel] as Record<string, unknown> | undefined;
    if (!channelDef || typeof channelDef !== 'object') continue;

    const scale = channelDef.scale as Record<string, unknown> | undefined;
    if (!scale || typeof scale !== 'object') continue;

    const scaleType = inferScaleType(channelDef);
    const basePointer = `${pointer}/encoding/${channel}/scale`;

    // ── Case 1: scale.range is a literal array of colors ──
    if (Array.isArray(scale.range)) {
      const colors = (scale.range as unknown[]).filter(
        (c): c is string => typeof c === 'string',
      );
      if (colors.length >= 2) {
        results.push({
          colors,
          scaleType,
          jsonPointer: `${basePointer}/range`,
          channel,
        });
      }
      continue; // range takes priority over scheme
    }

    // ── Case 2: scale.scheme is a string ──
    if (typeof scale.scheme === 'string') {
      const colors = resolveNamedScheme(scale.scheme);
      if (colors && colors.length >= 2) {
        results.push({
          colors,
          scaleType,
          jsonPointer: `${basePointer}/scheme`,
          channel,
          schemeName: scale.scheme,
        });
      }
      continue;
    }

    // ── Case 3: scale.scheme is an object { name, count?, extent? } ──
    if (
      scale.scheme &&
      typeof scale.scheme === 'object' &&
      !Array.isArray(scale.scheme)
    ) {
      const schemeObj = scale.scheme as Record<string, unknown>;
      const name = schemeObj.name;
      if (typeof name !== 'string') continue;

      const count = typeof schemeObj.count === 'number' ? schemeObj.count : undefined;
      const extent =
        Array.isArray(schemeObj.extent) && schemeObj.extent.length === 2
          ? (schemeObj.extent as [number, number])
          : undefined;

      const colors = resolveNamedScheme(name, count, extent);
      if (colors && colors.length >= 2) {
        results.push({
          colors,
          scaleType,
          jsonPointer: `${basePointer}/scheme`,
          channel,
          schemeName: name,
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
 * Only processes scales that the author explicitly defined — default
 * Vega-Lite schemes are not flagged (they are already reasonably safe).
 */
export function resolveScaleColors(spec: Record<string, unknown>): ResolvedScale[] {
  const results: ResolvedScale[] = [];
  walkSpec(spec, '', results);
  return results;
}
