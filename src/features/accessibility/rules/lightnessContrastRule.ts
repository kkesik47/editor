/**
 * lightnessContrastRule.ts
 *
 * Accessibility rule that checks whether colors in a Vega-Lite
 * color scale remain distinguishable when viewed in grayscale.
 *
 * Three checks:
 *   Categorical → all pairs must have ΔL* ≥ 20
 *   Sequential  → total L* range must be ≥ 40
 *   Sequential  → L* must progress monotonically (no reversals)
 *
 * Architecture:
 *   1. resolveScaleColors  — reused from the CVD rule
 *   2. analyzeLightness    — extract L*, find pairs, check monotonicity
 *   3. toGrayscale         — convert colors to gray equivalents
 *   4. this file           — orchestrate and produce issues
 */

import type {AccessibilityIssue, AccessibilityRule} from '../types.js';
import {resolveScaleColors, type ResolvedScale} from './colorblindSafety/resolveScaleColors.js';
import {
  analyzeLightness,
  toGrayscale,
  type LightnessAnalysisResult,
  CATEGORICAL_LIGHTNESS_THRESHOLD,
  SEQUENTIAL_LIGHTNESS_RANGE_THRESHOLD,
} from './lightnessAnalysis.js';

// ─── Issue builders ──────────────────────────────────────────────

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
 *
 * A well-designed sequential scale should have lightness that either
 * consistently increases or decreases. Non-monotonic lightness means
 * brightness doesn't track data values — two different values can
 * appear the same shade of gray, or a higher value can look lighter
 * than a lower one.
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

// ─── The rule ────────────────────────────────────────────────────

export const lightnessContrastRule: AccessibilityRule = {
  id: 'vl-a11y-lightness-contrast',

  description:
    'Checks whether colors in explicit color scales have sufficient ' +
    'lightness separation to remain distinguishable in grayscale, ' +
    'and whether sequential scales have monotonic lightness.',

  evaluate(spec: Record<string, unknown>): AccessibilityIssue[] {
    const scales = resolveScaleColors(spec);
    const issues: AccessibilityIssue[] = [];

    for (const scale of scales) {
      const analysis = analyzeLightness(scale.colors);
      const grayscaleColors = toGrayscale(scale.colors);

      if (scale.scaleType === 'categorical') {
        // Check: any pair of categories too close in lightness?
        if (analysis.problematicPairs.length > 0) {
          issues.push(buildCategoricalIssue(scale, analysis, grayscaleColors));
        }
      } else {
        // Check 1: is the total lightness range too narrow?
        if (analysis.totalRange < SEQUENTIAL_LIGHTNESS_RANGE_THRESHOLD) {
          issues.push(buildSequentialRangeIssue(scale, analysis, grayscaleColors));
        }

        // Check 2: does lightness progress monotonically?
        if (!analysis.isMonotonic) {
          issues.push(buildMonotonicityIssue(scale, analysis, grayscaleColors));
        }
      }
    }

    return issues;
  },
};
