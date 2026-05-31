/**
 * recommendations/perceptualUniformityAdjust.ts
 *
 * Finds Vega-registered colour schemes whose step profile clears
 * `perceptualUniformityRule` for a given scale shape.
 *
 * Same pattern as `contrastAdjust.findContrastSafeSchemes` and
 * `lightnessAdjust.findLightnessSafeSchemes`: we walk SCHEME_CATALOG,
 * resolve each candidate to colours at the same 16-sample density the
 * rule uses, and run it through the RULE'S OWN ANALYSIS FUNCTIONS
 * (`analyzePerceptualUniformity` / `analyzeDivergingUniformity`). A
 * scheme only survives if that analysis would classify it as "ok" —
 * i.e. the rule would not flag it.
 *
 * Reusing the rule's analysis (instead of recomputing) keeps "uniform"
 * honest: if the rule's thresholds ever change, the recommendations
 * follow automatically, with no drift between what we flag and what we
 * recommend. It also means we never offer a "fix" that would just trip
 * the same rule again.
 *
 * What "uniform" means per shape (mirrors `classify` in
 * perceptualUniformityRule.ts, the verdict === 'ok' branch):
 *
 *   sequential → CV ≤ CV_OK_THRESHOLD across the full sample
 *                sequence AND max/min step ratio ≤
 *                MAX_MIN_RATIO_THRESHOLD.
 *
 *   diverging  → each half (split at the midpoint) has CV ≤
 *                CV_OK_THRESHOLD AND max/min step ratio ≤
 *                MAX_MIN_RATIO_HALF_THRESHOLD. Both halves must pass,
 *                because the rule fires if EITHER half is non-uniform.
 *
 * Categorical scales have no notion of consecutive steps, so the rule
 * skips them and this helper only handles sequential / diverging.
 */

import {scheme as vegaScheme} from 'vega-scale';
import {
  analyzePerceptualUniformity,
  analyzeDivergingUniformity,
  CV_OK_THRESHOLD,
  MAX_MIN_RATIO_THRESHOLD,
  MAX_MIN_RATIO_HALF_THRESHOLD,
} from '../rules/perceptualUniformityAnalysis.js';
import {SCHEME_CATALOG, type SchemeEntry} from './schemeCatalog.js';

/** The two scale shapes this helper handles (the rule skips categorical). */
export type OrderedScaleType = 'sequential' | 'diverging';

/**
 * How many evenly-spaced samples to take from a continuous scheme.
 * Matches the rule's own sampling density (resolveScaleColors uses
 * 16), so each candidate is judged on the same colours a chart using
 * it would actually render.
 */
const CONTINUOUS_SAMPLE_COUNT = 16;

// ─── Scheme resolution ──────────────────────────────────────────
//
// We resolve schemes locally rather than reaching into
// resolveScaleColors' private helpers, to keep the recommendations
// module decoupled from the rule's internals — same approach as
// lightnessAdjust / contrastAdjust.

/**
 * Resolve a Vega scheme name to an array of colours, sampled the same
 * way the rule samples continuous scales.
 *
 * Returns null for unknown schemes or anything that isn't a continuous
 * interpolator. Sequential and diverging schemes are both continuous
 * (interpolator functions), which is all this helper needs — the rule
 * never runs uniformity analysis on discrete categorical schemes.
 */
function resolveSchemeColors(schemeName: string): string[] | null {
  let value: unknown;
  try {
    value = vegaScheme(schemeName);
  } catch {
    return null;
  }
  if (typeof value !== 'function') return null;

  const interpolator = value as (t: number) => string;
  const n = CONTINUOUS_SAMPLE_COUNT;
  const samples: string[] = [];
  for (let i = 0; i < n; i++) {
    samples.push(interpolator(i / (n - 1)));
  }
  return samples;
}

// ─── Uniformity predicates (mirror the rule's verdict === 'ok') ──

function isSequentialUniform(colors: string[]): boolean {
  const a = analyzePerceptualUniformity(colors);
  if (!a.hasSufficientColors) return false;
  return a.cv <= CV_OK_THRESHOLD && a.maxMinRatio <= MAX_MIN_RATIO_THRESHOLD;
}

function isDivergingUniform(colors: string[]): boolean {
  const a = analyzeDivergingUniformity(colors);
  if (!a.hasSufficientColors) return false;

  const halfIsOk = (cv: number, maxMinRatio: number): boolean =>
    cv <= CV_OK_THRESHOLD && maxMinRatio <= MAX_MIN_RATIO_HALF_THRESHOLD;

  // Both halves must be uniform — the rule fires if EITHER one isn't.
  return (
    halfIsOk(a.left.cv, a.left.maxMinRatio) &&
    halfIsOk(a.right.cv, a.right.maxMinRatio)
  );
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Find catalogue schemes whose step profile is uniform enough that
 * `perceptualUniformityRule` would not flag them.
 *
 * Only schemes matching the requested scale shape are considered, and
 * the original scheme (if any) is excluded so we never offer the same
 * one back. Returns an empty array when no candidate passes — at which
 * point the caller's `applicableWhen` should drop the recommendation
 * entirely.
 */
export function findUniformSchemes(args: {
  scaleType: OrderedScaleType;
  excludeSchemeName?: string | null;
}): SchemeEntry[] {
  const exclude = args.excludeSchemeName?.toLowerCase().replace(/-\d+$/, '');

  const candidates = SCHEME_CATALOG.filter(
    (s) => s.type === args.scaleType && s.name !== exclude,
  );

  const predicate =
    args.scaleType === 'sequential' ? isSequentialUniform : isDivergingUniform;

  const uniform: SchemeEntry[] = [];
  for (const candidate of candidates) {
    const colors = resolveSchemeColors(candidate.name);
    if (!colors || colors.length === 0) continue;
    if (predicate(colors)) uniform.push(candidate);
  }
  return uniform;
}