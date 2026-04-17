/**
 * perceptualUniformityRule.ts
 *
 * Accessibility rule that checks whether sequential color scales
 * have perceptually uniform steps — equal data intervals should
 * produce equal perceived color changes.
 *
 * Non-uniform scales (like rainbow) create false visual boundaries
 * and hide real gradients, misleading readers about the data.
 *
 * Two severity tiers based on the coefficient of variation (CV):
 *   CV > 0.5  → 'warning'  (clearly non-uniform, misleading)
 *   CV 0.3–0.5 → 'info'   (moderately uneven, could be improved)
 *
 * An additional check: if the max/min step ratio exceeds 4,
 * a warning is raised even if CV is below 0.5, because a single
 * localized jump can be just as misleading as overall unevenness.
 *
 * Only checks sequential scales — categorical scales have no
 * "adjacent step" concept. Only checks explicit author-defined
 * scales (not Vega-Lite defaults).
 *
 * Architecture:
 *   1. resolveScaleColors             — reused from CVD/lightness rules
 *   2. perceptualUniformityAnalysis   — compute step ΔE and evenness
 *   3. this file                      — orchestrate and produce issues
 */

import type {AccessibilityIssue, AccessibilityRule} from '../types.js';
import {resolveScaleColors, type ResolvedScale} from './colorblindSafety/resolveScaleColors.js';
import {
  analyzePerceptualUniformity,
  type UniformityAnalysisResult,
  CV_OK_THRESHOLD,
  CV_WARNING_THRESHOLD,
  MAX_MIN_RATIO_THRESHOLD,
} from './perceptualUniformityAnalysis.js';

// ─── Issue builders ──────────────────────────────────────────────

/**
 * Build a warning for a clearly non-uniform scale (CV > 0.5).
 */
function buildWarningIssue(
  scale: ResolvedScale,
  analysis: UniformityAnalysisResult,
): AccessibilityIssue {
  const schemeNote = scale.schemeName
    ? ` (scheme '${scale.schemeName}')`
    : '';

  return {
    ruleId: 'vl-a11y-perceptual-uniformity:high-cv',
    severity: 'warning',

    message:
      `The '${scale.channel}' sequential scale${schemeNote} is not ` +
      `perceptually uniform — equal steps in data do not produce ` +
      `equal steps in perceived color change. The largest color ` +
      `change between adjacent values is ${analysis.maxMinRatio}× ` +
      `the smallest, with a step unevenness score (CV) of ` +
      `${analysis.cv} (0 = perfectly even, above 0.5 = problematic). ` +
      `This can create false visual boundaries and make some data ` +
      `differences appear larger or smaller than they really are.`,

    suggestion:
      'Use a perceptually uniform scheme such as "viridis", ' +
      '"cividis", or "plasma" where equal data steps produce ' +
      'equal visual changes.',

    jsonPointer: scale.jsonPointer,

    evidence: {
      channel: scale.channel,
      scaleType: scale.scaleType,
      schemeName: scale.schemeName ?? null,
      cv: analysis.cv,
      maxMinRatio: analysis.maxMinRatio,
      mean: analysis.mean,
      stdDev: analysis.stdDev,
      maxStep: analysis.maxStep,
      minStep: analysis.minStep,
      stepCount: analysis.steps.length,
      steps: analysis.steps.map((s) => ({
        deltaE: s.deltaE,
        colorA: s.colorA,
        colorB: s.colorB,
      })),
    },
  };
}

/**
 * Build an info for a moderately uneven scale (CV 0.3–0.5).
 */
function buildInfoIssue(
  scale: ResolvedScale,
  analysis: UniformityAnalysisResult,
): AccessibilityIssue {
  const schemeNote = scale.schemeName
    ? ` (scheme '${scale.schemeName}')`
    : '';

  return {
    ruleId: 'vl-a11y-perceptual-uniformity:moderate-cv',
    severity: 'info',

    message:
      `The '${scale.channel}' sequential scale${schemeNote} has ` +
      `somewhat uneven perceptual steps — the largest color change ` +
      `between adjacent values is ${analysis.maxMinRatio}× the ` +
      `smallest, with a step unevenness score (CV) of ` +
      `${analysis.cv} (0 = perfectly even, above 0.5 = problematic). ` +
      `Some data ranges will appear to change faster than others, ` +
      `which may not faithfully represent the data.`,

    suggestion:
      'For more faithful data representation, consider a ' +
      'perceptually uniform scheme like "viridis" or "cividis".',

    jsonPointer: scale.jsonPointer,

    evidence: {
      channel: scale.channel,
      scaleType: scale.scaleType,
      schemeName: scale.schemeName ?? null,
      cv: analysis.cv,
      maxMinRatio: analysis.maxMinRatio,
      mean: analysis.mean,
      stdDev: analysis.stdDev,
      maxStep: analysis.maxStep,
      minStep: analysis.minStep,
      stepCount: analysis.steps.length,
      steps: analysis.steps.map((s) => ({
        deltaE: s.deltaE,
        colorA: s.colorA,
        colorB: s.colorB,
      })),
    },
  };
}

/**
 * Build a warning for a localized jump (max/min ratio > 4)
 * that the CV alone might not have caught.
 *
 * Only produced when CV is in the OK or moderate range but
 * the max/min ratio is extreme — this means most steps are
 * even except for one big outlier.
 */
function buildJumpIssue(
  scale: ResolvedScale,
  analysis: UniformityAnalysisResult,
): AccessibilityIssue {
  const schemeNote = scale.schemeName
    ? ` (scheme '${scale.schemeName}')`
    : '';

  // Find the step with the largest ΔE
  const largestStep = analysis.steps.reduce(
    (max, s) => (s.deltaE > max.deltaE ? s : max),
    analysis.steps[0],
  );

  // Find the step with the smallest ΔE
  const smallestStep = analysis.steps.reduce(
    (min, s) => (s.deltaE < min.deltaE ? s : min),
    analysis.steps[0],
  );

  return {
    ruleId: 'vl-a11y-perceptual-uniformity:localized-jump',
    severity: 'warning',

    message:
      `The '${scale.channel}' sequential scale${schemeNote} has ` +
      `a sudden color jump — one step in the scale changes ` +
      `${analysis.maxMinRatio}× more than the smallest step. ` +
      `This creates a false visual boundary at that point, ` +
      `making it look like there is a sharp break in the data ` +
      `when there may not be one.`,

    suggestion:
      'Consider a perceptually uniform scheme such as "viridis" ' +
      'or "cividis", or adjust your custom scale so that color ' +
      'changes are more evenly distributed.',

    jsonPointer: scale.jsonPointer,

    evidence: {
      channel: scale.channel,
      scaleType: scale.scaleType,
      schemeName: scale.schemeName ?? null,
      cv: analysis.cv,
      maxMinRatio: analysis.maxMinRatio,
      largestStep: {
        deltaE: largestStep.deltaE,
        colorA: largestStep.colorA,
        colorB: largestStep.colorB,
      },
      smallestStep: {
        deltaE: smallestStep.deltaE,
        colorA: smallestStep.colorA,
        colorB: smallestStep.colorB,
      },
      steps: analysis.steps.map((s) => ({
        deltaE: s.deltaE,
        colorA: s.colorA,
        colorB: s.colorB,
      })),
    },
  };
}

// ─── The rule ────────────────────────────────────────────────────

export const perceptualUniformityRule: AccessibilityRule = {
  id: 'vl-a11y-perceptual-uniformity',

  description:
    'Checks whether sequential color scales have perceptually ' +
    'uniform steps using CIEDE2000 between consecutive colors. ' +
    'Non-uniform scales create false visual boundaries.',

  evaluate(spec: Record<string, any>): AccessibilityIssue[] {
    const scales = resolveScaleColors(spec);
    const issues: AccessibilityIssue[] = [];

    for (const scale of scales) {
      // Only check sequential scales — categorical has no "steps"
      if (scale.scaleType !== 'sequential') continue;

      const analysis = analyzePerceptualUniformity(scale.colors);

      // Skip if not enough colors for reliable analysis
      if (!analysis.hasSufficientColors) continue;

      if (analysis.cv > CV_WARNING_THRESHOLD) {
        // Clearly non-uniform — warning
        issues.push(buildWarningIssue(scale, analysis));
      } else if (analysis.cv > CV_OK_THRESHOLD) {
        // Moderately uneven — info
        issues.push(buildInfoIssue(scale, analysis));
      } else if (analysis.maxMinRatio > MAX_MIN_RATIO_THRESHOLD) {
        // CV is OK overall, but there's a big localized jump
        issues.push(buildJumpIssue(scale, analysis));
      }
      // Otherwise: uniform enough, no issue
    }

    return issues;
  },
};