/**
 * lightnessContrastRule.ts
 *
 * Accessibility rule that checks whether colors in a Vega-Lite
 * color scale remain distinguishable when viewed in grayscale.
 *
 * Five checks across three scale shapes:
 *
 *   Categorical → all pairs must have ΔL* ≥ 20
 *
 *   Sequential  → total L* range must be ≥ 40
 *                 L* must progress monotonically (no reversals)
 *
 *   Diverging   → each half must span ≥ 20 L*  (from midpoint outward)
 *                 each half must progress monotonically
 *
 * Diverging is treated separately because a correctly designed
 * diverging palette (e.g. blueorange) has a V-shaped lightness
 * profile by design — checking the whole sequence for monotonicity
 * would always fail.
 *
 * Architecture:
 *   1. resolveScaleColors  — reused from the CVD rule
 *   2. analyzeLightness    — categorical / sequential analysis
 *   3. analyzeDivergingLightness — per-half diverging analysis
 *   4. toGrayscale         — convert colors to gray equivalents
 *   5. this file           — orchestrate and produce issues
 */

import type {AccessibilityIssue, AccessibilityRule} from '../types.js';
import {resolveScaleColors, type ResolvedScale} from './colorblindSafety/resolveScaleColors.js';
import {
  analyzeLightness,
  analyzeDivergingLightness,
  toGrayscale,
  type LightnessAnalysisResult,
  type DivergingLightnessAnalysisResult,
  CATEGORICAL_LIGHTNESS_THRESHOLD,
  SEQUENTIAL_LIGHTNESS_RANGE_THRESHOLD,
  DIVERGING_HALF_LIGHTNESS_RANGE_THRESHOLD,
} from './lightnessAnalysis.js';

// ─── Issue builders: categorical & sequential ───────────────────

/**
 * Build an issue for a categorical scale with pairs too close in L*.
 */
function buildCategoricalIssue(
  scale: ResolvedScale,
  analysis: LightnessAnalysisResult,
  grayscaleColors: string[],
): AccessibilityIssue {
  const pairCount = analysis.problematicPairs.length;
  const pairWord = pairCount === 1 ? 'pair' : 'pairs';

  return {
    ruleId: 'vl-a11y-lightness-contrast:categorical',
    severity: 'warning',

    message:
      `${pairCount} color ${pairWord} in the '${scale.channel}' scale ` +
      `have similar lightness (min ΔL* = ${analysis.minDeltaL}, ` +
      `threshold = ${CATEGORICAL_LIGHTNESS_THRESHOLD}). ` +
      `These colors may be hard to tell apart in grayscale or ` +
      `for users with very low color vision.`,

    suggestion:
      'Choose colors with more varied lightness values, or add ' +
      'redundant encodings such as shape, pattern, or direct labels.',

    jsonPointer: scale.jsonPointer,

    evidence: {
      checkType: 'categorical-pairs',
      channel: scale.channel,
      scaleType: scale.scaleType,
      schemeName: scale.schemeName ?? null,
      minDeltaL: analysis.minDeltaL,
      threshold: CATEGORICAL_LIGHTNESS_THRESHOLD,
      lightnessValues: analysis.lightnessValues,
      originalColors: scale.colors,
      grayscaleColors,
      problematicPairs: analysis.problematicPairs.map((pair) => ({
        colorA: pair.colorA,
        colorB: pair.colorB,
        lightnessA: pair.lightnessA,
        lightnessB: pair.lightnessB,
        deltaL: pair.deltaL,
      })),
    },
  };
}

/**
 * Build an issue for a sequential scale with insufficient L* range.
 */
function buildSequentialRangeIssue(
  scale: ResolvedScale,
  analysis: LightnessAnalysisResult,
  grayscaleColors: string[],
): AccessibilityIssue {
  return {
    ruleId: 'vl-a11y-lightness-contrast:sequential-range',
    severity: 'warning',

    message:
      `The '${scale.channel}' scale has a narrow lightness range ` +
      `(L* range = ${analysis.totalRange}, ` +
      `threshold = ${SEQUENTIAL_LIGHTNESS_RANGE_THRESHOLD}). ` +
      `In grayscale, this scale will appear as a nearly flat gray band, ` +
      `making it difficult to read data values.`,

    suggestion:
      'Use a sequential scheme with a wider lightness range, such as ' +
      '"viridis" or "blues". Alternatively, ensure your custom scale ' +
      'spans from a dark to a light color.',

    jsonPointer: scale.jsonPointer,

    evidence: {
      checkType: 'sequential-range',
      channel: scale.channel,
      scaleType: scale.scaleType,
      schemeName: scale.schemeName ?? null,
      totalRange: analysis.totalRange,
      threshold: SEQUENTIAL_LIGHTNESS_RANGE_THRESHOLD,
      lightnessValues: analysis.lightnessValues,
      originalColors: scale.colors,
      grayscaleColors,
    },
  };
}

/**
 * Build an issue for a sequential scale with non-monotonic lightness.
 */
function buildMonotonicityIssue(
  scale: ResolvedScale,
  analysis: LightnessAnalysisResult,
  grayscaleColors: string[],
): AccessibilityIssue {
  const reversalCount = analysis.reversals.length;
  const schemeNote = scale.schemeName ? ` (scheme '${scale.schemeName}')` : '';

  return {
    ruleId: 'vl-a11y-lightness-contrast:non-monotonic',
    severity: 'warning',

    message:
      `The '${scale.channel}' sequential scale${schemeNote} has ` +
      `non-monotonic lightness — the brightness reverses direction ` +
      `${reversalCount} ${reversalCount === 1 ? 'time' : 'times'}. ` +
      `A sequential scale should move from light (low values) to dark ` +
      `(high values), or vice versa, so that brightness consistently ` +
      `tracks the data. Non-monotonic lightness means different data ` +
      `values can appear as the same shade of gray, making the scale ` +
      `misleading in grayscale or for users with low color vision.`,

    suggestion:
      'Use a perceptually uniform sequential scheme such as "viridis", ' +
      '"cividis", or "blues", where lightness increases monotonically. ' +
      'Avoid rainbow-type scales where brightness oscillates.',

    jsonPointer: scale.jsonPointer,

    evidence: {
      checkType: 'sequential-monotonicity',
      channel: scale.channel,
      scaleType: scale.scaleType,
      schemeName: scale.schemeName ?? null,
      lightnessValues: analysis.lightnessValues,
      reversalCount,
      reversals: analysis.reversals,
      originalColors: scale.colors,
      grayscaleColors,
    },
  };
}

// ─── Issue builders: diverging ──────────────────────────────────

/**
 * Identify which halves of a diverging scale failed a check,
 * for use in the user-facing message.
 *
 * "lower" = start → midpoint, "upper" = midpoint → end.
 */
function describeFailingSides(leftFails: boolean, rightFails: boolean): string {
  if (leftFails && rightFails) return 'both';
  if (leftFails) return 'lower';
  return 'upper';
}

/**
 * Build an issue for a diverging scale where one or both halves
 * have too little lightness change between the midpoint and the
 * endpoint.
 */
function buildDivergingRangeIssue(
  scale: ResolvedScale,
  analysis: DivergingLightnessAnalysisResult,
  grayscaleColors: string[],
): AccessibilityIssue {
  const schemeNote = scale.schemeName ? ` (scheme '${scale.schemeName}')` : '';
  const threshold = DIVERGING_HALF_LIGHTNESS_RANGE_THRESHOLD;

  const leftFails = analysis.leftRange < threshold;
  const rightFails = analysis.rightRange < threshold;
  const sides = describeFailingSides(leftFails, rightFails);

  return {
    ruleId: 'vl-a11y-lightness-contrast:diverging-range',
    severity: 'warning',

    message:
      `The '${scale.channel}' diverging scale${schemeNote} has too ` +
      `little brightness change on the ${sides} ` +
      `${sides === 'both' ? 'halves' : 'half'} ` +
      `(lower half = ${analysis.leftRange} L*, ` +
      `upper half = ${analysis.rightRange} L*, ` +
      `threshold = ${threshold} per half). ` +
      `In grayscale, that side of the scale will look almost flat, ` +
      `making it hard to tell how far a value is from the midpoint.`,

    suggestion:
      'Use a diverging scheme with stronger brightness contrast at the ' +
      'endpoints, such as "blueorange" or "redblue". Alternatively, ' +
      'ensure your custom palette darkens (or lightens) noticeably ' +
      'as values move away from the midpoint on both sides.',

    jsonPointer: scale.jsonPointer,

    evidence: {
      checkType: 'diverging-range',
      channel: scale.channel,
      scaleType: scale.scaleType,
      schemeName: scale.schemeName ?? null,
      leftRange: analysis.leftRange,
      rightRange: analysis.rightRange,
      threshold,
      lightnessValues: analysis.lightnessValues,
      midIndex: analysis.midIndex,
      originalColors: scale.colors,
      grayscaleColors,
    },
  };
}

/**
 * Build an issue for a diverging scale where one or both halves
 * have a wavy / non-monotonic lightness profile.
 *
 * A correctly designed diverging scale changes brightness steadily
 * on each side of the midpoint. Wobbles on one side mean users
 * can't tell, in grayscale, how far a value is from the midpoint
 * on that side.
 */
function buildDivergingMonotonicityIssue(
  scale: ResolvedScale,
  analysis: DivergingLightnessAnalysisResult,
  grayscaleColors: string[],
): AccessibilityIssue {
  const schemeNote = scale.schemeName ? ` (scheme '${scale.schemeName}')` : '';
  const sides = describeFailingSides(!analysis.leftMonotonic, !analysis.rightMonotonic);

  return {
    ruleId: 'vl-a11y-lightness-contrast:diverging-non-monotonic',
    severity: 'warning',

    message:
      `The '${scale.channel}' diverging scale${schemeNote} has ` +
      `irregular brightness on the ${sides} ` +
      `${sides === 'both' ? 'halves' : 'half'}. ` +
      `A diverging scale should grow steadily lighter (or darker) ` +
      `as values move away from the midpoint, so that brightness ` +
      `reflects how far a value is from neutral. Oscillating ` +
      `brightness on one side means users cannot read ` +
      `distance-from-midpoint reliably on that side.`,

    suggestion:
      'Use a perceptually uniform diverging scheme such as ' +
      '"blueorange" or "purpleorange", where each half has a ' +
      'smooth lightness progression.',

    jsonPointer: scale.jsonPointer,

    evidence: {
      checkType: 'diverging-monotonicity',
      channel: scale.channel,
      scaleType: scale.scaleType,
      schemeName: scale.schemeName ?? null,
      lightnessValues: analysis.lightnessValues,
      midIndex: analysis.midIndex,
      leftMonotonic: analysis.leftMonotonic,
      rightMonotonic: analysis.rightMonotonic,
      leftReversals: analysis.leftReversals,
      rightReversals: analysis.rightReversals,
      originalColors: scale.colors,
      grayscaleColors,
    },
  };
}

// ─── The rule ────────────────────────────────────────────────────

export const lightnessContrastRule: AccessibilityRule = {
  id: 'vl-a11y-lightness-contrast',

  description:
    'Checks whether colors in explicit color scales have sufficient ' +
    'lightness separation to remain distinguishable in grayscale. ' +
    'Categorical scales are checked pairwise; sequential scales for ' +
    'total range and global monotonicity; diverging scales per-half ' +
    'for range and monotonicity (their lightness is expected to form ' +
    'a V around the midpoint).',

  evaluate(spec: Record<string, unknown>): AccessibilityIssue[] {
    const scales = resolveScaleColors(spec);
    const issues: AccessibilityIssue[] = [];

    for (const scale of scales) {
      const grayscaleColors = toGrayscale(scale.colors);

      if (scale.scaleType === 'categorical') {
        const analysis = analyzeLightness(scale.colors);
        if (analysis.problematicPairs.length > 0) {
          issues.push(buildCategoricalIssue(scale, analysis, grayscaleColors));
        }
      } else if (scale.scaleType === 'diverging') {
        const analysis = analyzeDivergingLightness(scale.colors);

        // Per-half range: each side must span enough L* to be readable.
        const threshold = DIVERGING_HALF_LIGHTNESS_RANGE_THRESHOLD;
        if (analysis.leftRange < threshold || analysis.rightRange < threshold) {
          issues.push(buildDivergingRangeIssue(scale, analysis, grayscaleColors));
        }

        // Per-half monotonicity: each side must move steadily.
        if (!analysis.leftMonotonic || !analysis.rightMonotonic) {
          issues.push(buildDivergingMonotonicityIssue(scale, analysis, grayscaleColors));
        }
      } else {
        // Sequential
        const analysis = analyzeLightness(scale.colors);

        if (analysis.totalRange < SEQUENTIAL_LIGHTNESS_RANGE_THRESHOLD) {
          issues.push(buildSequentialRangeIssue(scale, analysis, grayscaleColors));
        }

        if (!analysis.isMonotonic) {
          issues.push(buildMonotonicityIssue(scale, analysis, grayscaleColors));
        }
      }
    }

    return issues;
  },
};