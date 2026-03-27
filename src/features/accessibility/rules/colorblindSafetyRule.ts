/**
 * colorblindSafetyRule.ts
 *
 * Accessibility rule that checks whether explicit color scales in a
 * Vega-Lite specification remain distinguishable under simulated
 * color vision deficiencies (CVD).
 *
 * This rule is intentionally separate from the existing colorRiskRule,
 * which checks for risky color-family *combinations* (e.g. red + green
 * used together). This rule instead asks: "Can a person with CVD
 * actually distinguish the colors in this specific scale?"
 *
 * Architecture:
 *   1. resolveScaleColors  — find scales in the spec, resolve to color arrays
 *   2. evaluateColorblindSafety — simulate CVD, measure distinguishability
 *   3. this file            — orchestrate and produce AccessibilityIssue objects
 *
 * What this rule does NOT check:
 *   - Perceptual uniformity / equidistance (separate concern, separate rule)
 *   - SVG / rendered pixel analysis (spec-level only)
 *   - Default Vega-Lite schemes (only explicit author-defined scales)
 */

import type {AccessibilityIssue, AccessibilityRule} from '../types.js';
import {resolveScaleColors, type ResolvedScale} from './colorblindSafety/resolveScaleColors.js';
import {
  evaluateColorblindSafety,
  type CvdTestResult,
  CATEGORICAL_THRESHOLD,
  SEQUENTIAL_THRESHOLD,
} from './colorblindSafety/cvdSimulation.js';

// ─── Human-readable names for CVD types ──────────────────────────

const CVD_LABELS: Record<string, string> = {
  protanopia: 'protanopia (red-blind)',
  deuteranopia: 'deuteranopia (green-blind)',
  tritanopia: 'tritanopia (blue-yellow blind)',
};

// ─── Issue generation ────────────────────────────────────────────

/**
 * Build one AccessibilityIssue per CVD type that caused problems
 * on a given resolved scale.
 */
function buildIssues(
  scale: ResolvedScale,
  cvdResults: CvdTestResult[],
): AccessibilityIssue[] {
  return cvdResults.map((result) => {
    const label = CVD_LABELS[result.cvdType] ?? result.cvdType;
    const threshold =
      scale.scaleType === 'categorical' ? CATEGORICAL_THRESHOLD : SEQUENTIAL_THRESHOLD;
    const pairKind =
      scale.scaleType === 'categorical' ? 'color pairs' : 'adjacent color steps';

    const schemeNote = scale.schemeName
      ? ` (scheme '${scale.schemeName}')`
      : '';

    return {
      ruleId: `vl-a11y-colorblind-safety:${result.cvdType}`,
      severity: 'warning',

      message:
        `Under ${label} simulation, some ${pairKind} in the ` +
        `'${scale.channel}' scale${schemeNote} become nearly ` +
        `indistinguishable (min ΔE = ${result.minDeltaE}, ` +
        `threshold = ${threshold}).`,

      suggestion:
        scale.scaleType === 'categorical'
          ? 'Consider a colorblind-safe categorical palette, or add ' +
            'redundant encodings such as shape or pattern.'
          : 'Consider a CVD-safe sequential scheme such as "viridis" ' +
            'or "cividis", or increase the lightness range of your scale.',

      jsonPointer: scale.jsonPointer,

      evidence: {
        cvdType: result.cvdType,
        scaleType: scale.scaleType,
        channel: scale.channel,
        schemeName: scale.schemeName ?? null,
        minDeltaE: result.minDeltaE,
        threshold,
        resolvedColorCount: scale.colors.length,
        problematicPairs: result.problematicPairs.map((pair) => ({
          originalA: pair.originalA,
          originalB: pair.originalB,
          simulatedA: pair.simulatedA,
          simulatedB: pair.simulatedB,
          deltaE: pair.deltaE,
          indexA: pair.indexA,
          indexB: pair.indexB,
        })),
      },
    };
  });
}

// ─── The rule ────────────────────────────────────────────────────

export const colorblindSafetyRule: AccessibilityRule = {
  id: 'vl-a11y-colorblind-safety',

  description:
    'Simulates color vision deficiencies (protanopia, deuteranopia, ' +
    'tritanopia) on explicit color scales and checks whether the ' +
    'colors remain perceptually distinguishable using CIEDE2000.',

  evaluate(spec: Record<string, unknown>): AccessibilityIssue[] {
    // Step 1: Find all explicit color scales and resolve them to colors
    const scales = resolveScaleColors(spec);

    // Step 2: For each scale, simulate CVD and check distinguishability
    const issues: AccessibilityIssue[] = [];

    for (const scale of scales) {
      const cvdResults = evaluateColorblindSafety(scale.colors, scale.scaleType);

      // Step 3: Convert problematic results into AccessibilityIssue objects
      if (cvdResults.length > 0) {
        issues.push(...buildIssues(scale, cvdResults));
      }
    }

    return issues;
  },
};
