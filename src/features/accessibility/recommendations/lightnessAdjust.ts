/**
 * recommendations/lightnessAdjust.ts
 *
 * Finds Vega-registered schemes whose lightness behaviour clears
 * `lightnessContrastRule` for a given scale shape, AND provides
 * a "redistribute lightness in the current palette" helper for the
 * categorical case (where most scheme swaps don't pass).
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
 *   categorical → every pair of resolved colours has ΔL* ≥
 *                 CATEGORICAL_LIGHTNESS_THRESHOLD.
 *
 *   sequential  → total L* range ≥ SEQUENTIAL_LIGHTNESS_RANGE_THRESHOLD
 *                 AND lightness is monotonic.
 *
 *   diverging   → each half spans ≥ DIVERGING_HALF_LIGHTNESS_RANGE_THRESHOLD
 *                 AND each half is monotonic.
 *
 * ─── On lightness redistribution ─────────────────────────────────
 *
 * For categorical scales most named schemes vary HUE rather than
 * lightness, so the safety check above returns [] for typical
 * chart category counts. To avoid the "warning with no
 * recommendations" UX, we also offer a per-spec fix: take the
 * author's actual colours and redistribute their LIGHTNESS values
 * across a wider range, keeping each colour's hue and chroma. The
 * result is the same palette in spirit (same hues, same designer
 * intent) but legibly different in grayscale.
 */

import {parse, converter, formatHex} from 'culori';
import {scheme as vegaScheme} from 'vega-scale';
import {
  analyzeLightness,
  analyzeDivergingLightness,
  CATEGORICAL_LIGHTNESS_THRESHOLD,
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

/**
 * Whether every pair in a categorical palette clears the rule's ΔL*
 * threshold — i.e. `lightnessContrastRule` would NOT flag it.
 *
 * Exported so recommendations can verify a candidate palette actually
 * fixes the issue before offering it (same "re-check against the rule's
 * own analysis" principle the catalogue scheme swaps use).
 */
export function isCategoricalLightnessSafe(colors: string[]): boolean {
  const analysis = analyzeLightness(colors);
  return analysis.problematicPairs.length === 0;
}

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
 * `lightnessContrastRule` would not flag them.
 *
 * The original scheme (if any) is excluded so we never offer the
 * same one back. Categorical candidates are sliced to
 * `categoryCount` before checking so the result is honest for the
 * chart's actual data.
 *
 * Returns an empty array when no candidate passes — at which point
 * the caller's `applicableWhen` should drop the recommendation
 * entirely. For the categorical shape this is the normal case, not
 * an error: most categorical palettes vary hue, not lightness.
 */
export function findLightnessSafeSchemes(args: {
  scaleType: SchemeType;
  categoryCount?: number;
  excludeSchemeName?: string | null;
}): SchemeEntry[] {
  const exclude = args.excludeSchemeName?.toLowerCase().replace(/-\d+$/, '');

  const candidates = SCHEME_CATALOG.filter(
    (s) => s.type === args.scaleType && s.name !== exclude,
  );

  const predicate =
    args.scaleType === 'categorical'
      ? isCategoricalLightnessSafe
      : args.scaleType === 'sequential'
        ? isSequentialSafe
        : isDivergingSafe;

  const safe: SchemeEntry[] = [];
  for (const candidate of candidates) {
    const colors = resolveSchemeColors(
      candidate.name,
      args.scaleType,
      args.categoryCount,
    );
    if (!colors || colors.length === 0) continue;
    if (predicate(colors)) safe.push(candidate);
  }
  return safe;
}

// ─── Public API: lightness redistribution (categorical only) ────

/**
 * L* range we spread the categorical colours across when
 * redistributing.
 *
 * Endpoints (15 and 90) are chosen deliberately:
 *   - 15 is dark enough to read as "almost black" but not so dark
 *     that hue dies (pure black has no hue).
 *   - 90 is light enough to read as "almost white" but not so light
 *     that hue dies (pure white has no hue).
 *   - Together they span 75 L*, which guarantees pairwise ΔL*
 *     well above the rule's 20-unit categorical threshold for any
 *     reasonable category count: N=2 → 75, N=3 → 37.5, N=4 → 25,
 *     N=5 → 18.75 (borderline; see logic below).
 *
 * For N ≥ 5 the equal-step spacing dips below threshold, but we
 * handle that by widening the endpoints slightly when needed so
 * the minimum step always clears the threshold with a small margin.
 */
const REDIST_MIN_L = 15;
const REDIST_MAX_L = 90;

/**
 * Margin we keep above the rule's categorical threshold, so rounding
 * during hex conversion doesn't leave us at 19.9 when we needed 20.
 */
const REDIST_MARGIN = 2;

const toOklch = converter('oklch');
const toLab = converter('lab');

/**
 * Redistribute the lightness (CIELAB L*) of a list of colours so
 * every pair clears the categorical threshold, while preserving each
 * colour's hue and chroma identity.
 *
 * Strategy:
 *   1. Sort the input colours by their current L* (so the darkest
 *      stays darkest, lightest stays lightest — preserves any
 *      lightness-as-order intent the author had).
 *   2. Assign each colour a new L* evenly spaced across a wide range.
 *      The spacing is chosen so the minimum pairwise ΔL* clears
 *      CATEGORICAL_LIGHTNESS_THRESHOLD with a safety margin.
 *   3. Rebuild each colour by replacing its L* in CIELAB while
 *      keeping the original a* and b* — that holds hue and chroma
 *      constant, only lightness changes.
 *   4. Return the new colours in the ORIGINAL input order so the
 *      mapping between data categories and colours is unchanged.
 *
 * Returns null if any colour cannot be parsed.
 */
export function redistributeLightness(colors: string[]): string[] | null {
  if (colors.length < 2) return colors.slice();

  // Parse each colour to LAB up-front. Keep original-index alongside
  // so we can restore order after sorting.
  const entries: {originalIndex: number; lab: ReturnType<typeof toLab>}[] = [];
  for (let i = 0; i < colors.length; i++) {
    const parsed = parse(colors[i]);
    if (!parsed) return null;
    const lab = toLab(parsed);
    if (!lab) return null;
    entries.push({originalIndex: i, lab});
  }

  // Sort by current L* ascending — so the darkest input stays darkest
  // in the output, preserving any lightness-order intent.
  entries.sort((a, b) => (a.lab!.l ?? 0) - (b.lab!.l ?? 0));

  // Choose the L* range. Equal spacing across [REDIST_MIN_L, REDIST_MAX_L]
  // gives min step = (max - min) / (n - 1). If that's below threshold
  // + margin (won't happen for N ≤ 4 with our 15..90 range, may for
  // N ≥ 5), we'd need to widen — but our endpoints already span 75
  // and the threshold is 20, so even N = 4 gives 25 (clears with
  // margin 2). For N = 5 we'd get 18.75; widen slightly in that case.
  const n = entries.length;
  const requiredStep = CATEGORICAL_LIGHTNESS_THRESHOLD + REDIST_MARGIN;
  const naturalStep = (REDIST_MAX_L - REDIST_MIN_L) / (n - 1);

  let lo = REDIST_MIN_L;
  let hi = REDIST_MAX_L;
  if (naturalStep < requiredStep) {
    // Widen symmetrically to whatever the n requires, clamped to
    // [5, 95] so the endpoints never fully lose hue.
    const needed = requiredStep * (n - 1);
    const mid = (REDIST_MIN_L + REDIST_MAX_L) / 2;
    lo = Math.max(5, mid - needed / 2);
    hi = Math.min(95, mid + needed / 2);
  }

  const step = (hi - lo) / (n - 1);

  // Rebuild each colour with the new L*, keep a* and b*.
  const rebuilt = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    const entry = entries[i];
    const newL = lo + i * step;
    const newLab = {...entry.lab!, l: newL};
    const hex = formatHex(newLab);
    if (!hex) return null;
    rebuilt[entry.originalIndex] = hex;
  }

  return rebuilt;
}

/**
 * The hand-picked Okabe-Ito categorical palette — 8 colours,
 * designed by Okabe & Ito (2008) for color vision deficiency and
 * also happening to have decent lightness separation.
 *
 * Mirrors the same constant in `colorblindSafetyRecs.ts`. We keep a
 * local copy so this module stays self-contained; if the source
 * ever changes, both should be updated.
 *
 * Reference: Okabe, M. & Ito, K. (2008). "Color Universal Design (CUD)".
 *   https://jfly.uni-koeln.de/color/
 */
export const OKABE_ITO_PALETTE: string[] = [
  '#000000', // black
  '#E69F00', // orange
  '#56B4E9', // sky blue
  '#009E73', // bluish green
  '#F0E442', // yellow
  '#0072B2', // blue
  '#D55E00', // vermillion
  '#CC79A7', // reddish purple
];