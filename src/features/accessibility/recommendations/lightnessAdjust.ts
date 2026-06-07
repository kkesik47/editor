/**
 * recommendations/lightnessAdjust.ts
 *
 * Finds Vega-registered schemes whose lightness behaviour clears
 * `lightnessContrastRule` for a given ordered scale shape.
 *
 * Same pattern as `contrastAdjust.findContrastSafeSchemes`: we walk
 * `SCHEME_CATALOG`, resolve each scheme at an appropriate sample
 * density, and run it through the RULE'S OWN ANALYSIS FUNCTIONS
 * (`analyzeLightness` / `analyzeDivergingLightness`). A scheme only
 * survives if the analysis would not flag it.
 *
 * Why reuse the rule's analysis instead of recomputing? Because that
 * keeps "safe" honest: if the rule's thresholds or monotonicity
 * heuristic ever change, the recommendations follow automatically.
 * No drift between what we measure and what we recommend.
 *
 * What "safe" means per shape:
 *
 *   sequential  → total L* range ≥ SEQUENTIAL_LIGHTNESS_RANGE_THRESHOLD
 *                 AND lightness is monotonic.
 *
 *   diverging   → each half spans ≥ DIVERGING_HALF_LIGHTNESS_RANGE_THRESHOLD
 *                 AND each half is monotonic.
 *
 * Categorical scales are not handled here: the lightness rule does
 * not apply to them (qualitative palettes trade lightness uniformity
 * for hue diversity by design — Brewer 2003; Wong 2011).
 */

import {scheme as vegaScheme} from 'vega-scale';
import {
  analyzeLightness,
  analyzeDivergingLightness,
  SEQUENTIAL_LIGHTNESS_RANGE_THRESHOLD,
  DIVERGING_HALF_LIGHTNESS_RANGE_THRESHOLD,
} from '../rules/lightnessAnalysis.js';
import {SCHEME_CATALOG, type SchemeType, type SchemeEntry} from './schemeCatalog.js';

// ─── Scheme resolution ──────────────────────────────────────────
//
// We resolve schemes the same way `resolveScaleColors` does, but
// locally — the helper there isn't exported and we don't want to
// couple the recommendations module to its private internals.

/** Sample count for continuous (sequential / diverging) schemes. */
const CONTINUOUS_SAMPLE_COUNT = 16;

function resolveSchemeColors(
  schemeName: string,
  scaleType: SchemeType,
  categoryCount?: number,
): string[] | null {
  let value: unknown;
  try {
    value = vegaScheme(schemeName);
  } catch {
    return null;
  }
  if (!value) return null;

  // Continuous interpolator → sample evenly across [0, 1].
  if (typeof value === 'function') {
    const n = CONTINUOUS_SAMPLE_COUNT;
    const samples: string[] = [];
    for (let i = 0; i < n; i++) {
      samples.push((value as (t: number) => string)(i / (n - 1)));
    }
    return samples;
  }

  // Discrete categorical scheme → array of strings. Slice to the
  // requested category count so analysis matches what the chart
  // will actually render.
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
    const colors = value as string[];
    return categoryCount && categoryCount > 0
      ? colors.slice(0, categoryCount)
      : colors;
  }

  return null;
}

// ─── Safety predicates ──────────────────────────────────────────

function isSequentialSafe(colors: string[]): boolean {
  const analysis = analyzeLightness(colors);
  return (
    analysis.totalRange >= SEQUENTIAL_LIGHTNESS_RANGE_THRESHOLD &&
    analysis.isMonotonic
  );
}

function isDivergingSafe(colors: string[]): boolean {
  const analysis = analyzeDivergingLightness(colors);
  const threshold = DIVERGING_HALF_LIGHTNESS_RANGE_THRESHOLD;
  return (
    analysis.leftRange >= threshold &&
    analysis.rightRange >= threshold &&
    analysis.leftMonotonic &&
    analysis.rightMonotonic
  );
}

// ─── Public API: scheme safety scan ─────────────────────────────

/**
 * Find catalogue schemes whose lightness profile is good enough that
 * `lightnessContrastRule` would not flag them. Sequential and
 * diverging shapes only — the lightness rule does not apply to
 * categorical scales.
 *
 * The original scheme (if any) is excluded so we never offer the
 * same one back.
 *
 * Returns an empty array when no candidate passes — at which point
 * the caller's `applicableWhen` should drop the recommendation
 * entirely.
 */
export function findLightnessSafeSchemes(args: {
  scaleType: 'sequential' | 'diverging';
  excludeSchemeName?: string | null;
}): SchemeEntry[] {
  const exclude = args.excludeSchemeName?.toLowerCase().replace(/-\d+$/, '');

  const candidates = SCHEME_CATALOG.filter(
    (s) => s.type === args.scaleType && s.name !== exclude,
  );

  const predicate =
    args.scaleType === 'sequential' ? isSequentialSafe : isDivergingSafe;

  const safe: SchemeEntry[] = [];
  for (const candidate of candidates) {
    const colors = resolveSchemeColors(candidate.name, args.scaleType);
    if (!colors || colors.length === 0) continue;
    if (predicate(colors)) safe.push(candidate);
  }
  return safe;
}