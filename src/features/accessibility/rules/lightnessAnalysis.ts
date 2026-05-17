/**
 * lightnessAnalysis.ts
 *
 * Analyzes whether colors in a scale remain distinguishable when
 * reduced to lightness only (grayscale). This matters for:
 *   - Users with very low color vision or achromatopsia
 *   - Black-and-white printing
 *   - Monochrome displays
 *
 * Uses CIELAB L* (perceptual lightness) extracted via the `culori`
 * library. L* ranges from 0 (black) to 100 (white) and is designed
 * to be perceptually uniform — equal numeric differences correspond
 * to roughly equal perceived differences.
 *
 * Four checks are performed, depending on the scale shape:
 *
 *   Categorical scales → all pairs must have ΔL* ≥ 20.
 *     If two categories have similar lightness, they become
 *     indistinguishable in grayscale.
 *
 *   Sequential scales → two checks:
 *     1. Total L* range must be ≥ 40.
 *        Below this the scale looks like a flat gray band.
 *     2. L* must progress monotonically (no significant reversals).
 *        Non-monotonic lightness means the perceptual ordering
 *        doesn't match the data ordering — users can't use
 *        brightness to read values reliably.
 *
 *   Diverging scales → analysed via `analyzeDivergingLightness`:
 *     Each half (midpoint→endpoint) is checked independently for
 *     L* range and monotonicity. A diverging scale is *expected*
 *     to have non-monotonic global lightness (a V-shape around
 *     the midpoint), so checking the whole sequence at once would
 *     always fail.
 */

import {parse, converter, formatHex} from 'culori';

// ─── Constants ───────────────────────────────────────────────────

/**
 * Minimum ΔL* between any two categorical colors.
 *
 * A ΔL* of 20 is roughly the difference between a medium-dark gray
 * and a noticeably different gray. Below this, two categories risk
 * merging in grayscale.
 */
export const CATEGORICAL_LIGHTNESS_THRESHOLD = 20;

/**
 * Minimum total L* range for a sequential scale.
 *
 * Well-designed sequential scales like viridis span ~85 L* units.
 * A range below 40 means the lightest and darkest values are too
 * close together, producing an unreadable grayscale gradient.
 */
export const SEQUENTIAL_LIGHTNESS_RANGE_THRESHOLD = 40;

/**
 * Minimum L* range per half for a diverging scale.
 *
 * Each half spans half the data range (midpoint → endpoint), so the
 * threshold is half of the sequential one. Below 20 L* per half,
 * that side of the gradient looks nearly flat in grayscale, and
 * users can't read distance-from-midpoint on that side.
 */
export const DIVERGING_HALF_LIGHTNESS_RANGE_THRESHOLD = 20;

/**
 * Minimum ΔL* between consecutive samples to count as a real
 * direction change (not noise from sampling a smooth interpolator).
 *
 * At 16 samples, tiny fluctuations of 1–2 L* between neighbors
 * are normal rounding behavior. Only reversals ≥ 5 L* represent
 * a genuine change in lightness direction.
 */
export const MONOTONICITY_REVERSAL_THRESHOLD = 5;

// ─── Types ───────────────────────────────────────────────────────

/** A pair of colors that are too close in lightness. */
export interface LightnessPair {
  indexA: number;
  indexB: number;
  colorA: string;
  colorB: string;
  lightnessA: number;
  lightnessB: number;
  deltaL: number;
}

/** A point where lightness reverses direction in a sequential scale. */
export interface LightnessReversal {
  /** Sample index where the reversal occurs. */
  index: number;
  /** L* value at the reversal point. */
  lightness: number;
  /** Direction before reversal: 'rising' or 'falling'. */
  directionBefore: 'rising' | 'falling';
}

/** Result of analyzing one scale's lightness distribution. */
export interface LightnessAnalysisResult {
  /** L* values for each color in the input array. */
  lightnessValues: number[];
  /** The smallest ΔL* found between any two colors (categorical). */
  minDeltaL: number;
  /** The total L* range: max(L*) - min(L*) (sequential). */
  totalRange: number;
  /** Pairs that fell below the categorical threshold. */
  problematicPairs: LightnessPair[];
  /** Whether the L* profile is monotonic (sequential scales). */
  isMonotonic: boolean;
  /** Points where lightness reverses direction (empty if monotonic). */
  reversals: LightnessReversal[];
}

/**
 * Result of analyzing a diverging scale's lightness profile.
 *
 * Each half is reported separately: the "left" half is from the
 * start of the scale up to and including the midpoint sample;
 * the "right" half is from the midpoint to the end.
 */
export interface DivergingLightnessAnalysisResult {
  /** L* values for each color in the input array. */
  lightnessValues: number[];
  /** Index of the midpoint sample (Math.floor(n / 2)). */
  midIndex: number;
  /** |L*(midpoint) − L*(start)|. */
  leftRange: number;
  /** |L*(end) − L*(midpoint)|. */
  rightRange: number;
  /** Whether the left half progresses monotonically. */
  leftMonotonic: boolean;
  /** Whether the right half progresses monotonically. */
  rightMonotonic: boolean;
  /** Reversal points within the left half (start → midpoint). */
  leftReversals: LightnessReversal[];
  /** Reversal points within the right half (midpoint → end). */
  rightReversals: LightnessReversal[];
}

// ─── CIELAB conversion ───────────────────────────────────────────

const toLab = converter('lab');

function extractLightness(color: string): number | null {
  const parsed = parse(color);
  if (!parsed) return null;

  const lab = toLab(parsed);
  return lab ? round1(lab.l) : null;
}

/** Round to 1 decimal place for readable output. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ─── Grayscale conversion ────────────────────────────────────────

/**
 * Convert a color to its perceptual grayscale equivalent.
 *
 * Sets the CIELAB a* and b* channels to 0 (removing all chroma),
 * keeping only the L* (lightness) channel. This produces the gray
 * that matches the color's perceived brightness.
 */
function colorToGray(color: string): string {
  const parsed = parse(color);
  if (!parsed) return '#000000';

  const lab = toLab(parsed);
  if (!lab) return '#000000';

  lab.a = 0;
  lab.b = 0;

  return formatHex(lab) ?? '#000000';
}

/**
 * Convert an array of colors to their grayscale equivalents.
 *
 * Used by the renderer to show "Normal vs Grayscale" preview
 * swatches in the hover tooltip.
 */
export function toGrayscale(colors: string[]): string[] {
  return colors.map(colorToGray);
}

// ─── Monotonicity check ─────────────────────────────────────────

/**
 * Check whether a sequence of L* values progresses monotonically.
 *
 * A sequential color scale should have lightness that either
 * consistently increases or consistently decreases across its
 * range. Non-monotonic lightness (e.g., rainbow) means brightness
 * doesn't track data values, making the scale misleading.
 *
 * Small fluctuations below MONOTONICITY_REVERSAL_THRESHOLD are
 * ignored — these are normal at 16 samples and don't represent
 * real perceptual direction changes.
 *
 * @returns An object with isMonotonic flag and any reversal points.
 */
function checkMonotonicity(
  lightnessValues: number[],
): {isMonotonic: boolean; reversals: LightnessReversal[]} {
  if (lightnessValues.length < 3) {
    return {isMonotonic: true, reversals: []};
  }

  // Determine the overall trend direction from first to last value
  const overallDelta = lightnessValues[lightnessValues.length - 1] - lightnessValues[0];
  const expectedDirection: 'rising' | 'falling' = overallDelta >= 0 ? 'rising' : 'falling';

  const reversals: LightnessReversal[] = [];

  // Track the current direction using a running extreme value.
  // A reversal occurs when the value moves significantly
  // against the expected direction from the last extreme.
  let lastExtreme = lightnessValues[0];

  for (let i = 1; i < lightnessValues.length; i++) {
    const current = lightnessValues[i];

    if (expectedDirection === 'rising') {
      if (current >= lastExtreme) {
        // Still rising — update the extreme
        lastExtreme = current;
      } else if (lastExtreme - current >= MONOTONICITY_REVERSAL_THRESHOLD) {
        // Significant drop against the rising trend
        reversals.push({
          index: i,
          lightness: current,
          directionBefore: 'rising',
        });
        lastExtreme = current;
      }
    } else {
      if (current <= lastExtreme) {
        // Still falling — update the extreme
        lastExtreme = current;
      } else if (current - lastExtreme >= MONOTONICITY_REVERSAL_THRESHOLD) {
        // Significant rise against the falling trend
        reversals.push({
          index: i,
          lightness: current,
          directionBefore: 'falling',
        });
        lastExtreme = current;
      }
    }
  }

  return {
    isMonotonic: reversals.length === 0,
    reversals,
  };
}

// ─── Analysis ────────────────────────────────────────────────────

/**
 * Analyze the lightness distribution of a set of colors.
 *
 * Used for categorical and sequential scales. For diverging scales,
 * use `analyzeDivergingLightness` instead, since global monotonicity
 * does not apply.
 *
 * Extracts CIELAB L* for each color and computes:
 *   - All pairwise ΔL* values (for categorical threshold checks)
 *   - Total L* range (for sequential threshold checks)
 *   - Monotonicity (for sequential direction checks)
 *   - Which pairs fall below the categorical threshold
 *
 * Colors that fail to parse are skipped silently.
 */
export function analyzeLightness(colors: string[]): LightnessAnalysisResult {
  const entries: {index: number; color: string; lightness: number}[] = [];

  for (let i = 0; i < colors.length; i++) {
    const l = extractLightness(colors[i]);
    if (l !== null) {
      entries.push({index: i, color: colors[i], lightness: l});
    }
  }

  const lightnessValues = entries.map((e) => e.lightness);

  // Compute total range
  const minL = Math.min(...lightnessValues);
  const maxL = Math.max(...lightnessValues);
  const totalRange = round1(maxL - minL);

  // Check monotonicity
  const {isMonotonic, reversals} = checkMonotonicity(lightnessValues);

  // Find all pairs below the categorical threshold
  const problematicPairs: LightnessPair[] = [];
  let minDeltaL = Infinity;

  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const deltaL = round1(Math.abs(entries[i].lightness - entries[j].lightness));

      if (deltaL < minDeltaL) {
        minDeltaL = deltaL;
      }

      if (deltaL < CATEGORICAL_LIGHTNESS_THRESHOLD) {
        problematicPairs.push({
          indexA: entries[i].index,
          indexB: entries[j].index,
          colorA: entries[i].color,
          colorB: entries[j].color,
          lightnessA: entries[i].lightness,
          lightnessB: entries[j].lightness,
          deltaL,
        });
      }
    }
  }

  return {
    lightnessValues,
    minDeltaL: minDeltaL === Infinity ? 0 : round1(minDeltaL),
    totalRange,
    problematicPairs,
    isMonotonic,
    reversals,
  };
}

/**
 * Analyze the lightness profile of a diverging color scale.
 *
 * Diverging scales encode values that move away from a neutral
 * midpoint in two opposite directions, so their expected lightness
 * profile is a V-shape (or inverted V): light or dark at the
 * midpoint, opposite at both endpoints.
 *
 * Because of this, global monotonicity always fails for a correctly
 * designed diverging scale. Instead, we split the samples at the
 * midpoint and check each half independently for:
 *   - L* range (each half should span at least DIVERGING_HALF_LIGHTNESS_RANGE_THRESHOLD)
 *   - Monotonicity (each half should move steadily towards the endpoint)
 *
 * Both halves include the midpoint sample, so a kink right at the
 * centre is caught in both sub-sequences.
 */
export function analyzeDivergingLightness(
  colors: string[],
): DivergingLightnessAnalysisResult {
  const lightnessValues: number[] = [];

  for (const color of colors) {
    const l = extractLightness(color);
    if (l !== null) lightnessValues.push(l);
  }

  const n = lightnessValues.length;
  const midIndex = Math.floor(n / 2);

  // Both halves include the midpoint sample to detect kinks at the centre.
  const left = lightnessValues.slice(0, midIndex + 1);
  const right = lightnessValues.slice(midIndex);

  const leftRange = left.length >= 2
    ? round1(Math.abs(left[left.length - 1] - left[0]))
    : 0;

  const rightRange = right.length >= 2
    ? round1(Math.abs(right[right.length - 1] - right[0]))
    : 0;

  const leftCheck = checkMonotonicity(left);
  const rightCheck = checkMonotonicity(right);

  return {
    lightnessValues,
    midIndex,
    leftRange,
    rightRange,
    leftMonotonic: leftCheck.isMonotonic,
    rightMonotonic: rightCheck.isMonotonic,
    leftReversals: leftCheck.reversals,
    rightReversals: rightCheck.reversals,
  };
}