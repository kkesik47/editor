import {AccessibilityIssue, AccessibilityRule} from './types.js';
import {colorRiskRule} from './rules/colorRiskRule.js';
import {colorblindSafetyRule} from './rules/colorblindSafetyRule.js';
import {lightnessContrastRule} from './rules/lightnessContrastRule.js';
import {simulateCvdColors} from './rules/colorblindSafety/cvdSimulation.js';

const DEFAULT_VEGA_LITE_ACCESSIBILITY_RULES: AccessibilityRule[] = [
  colorRiskRule,
  colorblindSafetyRule,
  lightnessContrastRule,
];

/**
 * When both colorRiskRule and colorblindSafetyRule flag the same
 * scale, the CVD simulation result is strictly more informative
 * (it tells you which deficiency type and the exact ΔE).
 *
 * This function removes colorRiskRule issues when the simulation
 * rule already covers the same encoding channel.
 *
 * Match logic: a colorRiskRule issue at e.g.
 *   /encoding/color/scale/range/2
 * is covered by a colorblindSafetyRule issue at
 *   /encoding/color/scale/range
 * because the risk-rule pointer is a child of the safety-rule pointer.
 */
function deduplicateColorIssues(issues: AccessibilityIssue[]): AccessibilityIssue[] {
  const cvdPointers = issues
    .filter((issue) => issue.ruleId.startsWith('vl-a11y-colorblind-safety'))
    .map((issue) => issue.jsonPointer);

  return issues.filter((issue) => {
    if (!issue.ruleId.startsWith('vl-a11y-color-risk-rules')) {
      return true;
    }

    const isCoveredByCvd = cvdPointers.some((cvdPointer) => issue.jsonPointer.startsWith(cvdPointer));

    return !isCoveredByCvd;
  });
}

/**
 * Enrich surviving colorRiskRule issues with CVD preview data.
 *
 * The colorRiskRule identifies risky color-family combinations
 * (e.g. red + green) but doesn't simulate what they look like
 * under CVD. This step extracts the matched colors, simulates
 * the first relevant CVD type, and attaches the preview data
 * so the renderer can show "Normal vs [CVD type]" swatches.
 *
 * This only runs on colorRiskRule issues that survived deduplication
 * (i.e., ones where the CVD simulation rule did NOT also flag the
 * same scale — because those already have their own previews).
 */
function enrichWithCvdPreview(issues: AccessibilityIssue[]): AccessibilityIssue[] {
  return issues.map((issue) => {
    // Only enrich colorRiskRule issues
    if (!issue.ruleId.startsWith('vl-a11y-color-risk-rules')) {
      return issue;
    }

    const evidence = issue.evidence;
    const matchedColors = evidence?.matchedColors;
    const cvdTypes = evidence?.cvdTypes;

    // Need matched colors and at least one CVD type to simulate
    if (!Array.isArray(matchedColors) || matchedColors.length === 0) {
      return issue;
    }
    if (!Array.isArray(cvdTypes) || cvdTypes.length === 0) {
      return issue;
    }

    // Extract unique color values from matched colors
    const colorValues: string[] = [];
    const seen = new Set<string>();
    for (const mc of matchedColors) {
      const value = (mc as Record<string, unknown>)?.value;
      if (typeof value === 'string' && !seen.has(value)) {
        seen.add(value);
        colorValues.push(value);
      }
    }

    if (colorValues.length < 2) {
      return issue;
    }

    // Simulate the first (most relevant) CVD type
    const cvdType = cvdTypes[0] as string;
    const simulatedColors = simulateCvdColors(colorValues, cvdType as any);

    return {
      ...issue,
      evidence: {
        ...evidence,
        originalColors: colorValues,
        simulatedColors,
        cvdType,
        scaleType: 'categorical',
      },
    };
  });
}

export function evaluateVegaLiteAccessibility(
  spec: Record<string, any>,
  rules: AccessibilityRule[] = DEFAULT_VEGA_LITE_ACCESSIBILITY_RULES,
): AccessibilityIssue[] {
  const allIssues = rules.flatMap((rule) => rule.evaluate(spec));
  const deduplicated = deduplicateColorIssues(allIssues);
  const enriched = enrichWithCvdPreview(deduplicated);

  // Sort: colorblind safety first, then color risk, then lightness
  const priority: Record<string, number> = {
    'vl-a11y-colorblind-safety': 0,
    'vl-a11y-color-risk-rules': 1,
    'vl-a11y-lightness-contrast': 2,
  };

  return enriched.sort((a, b) => {
    const aPrefix = Object.keys(priority).find((p) => a.ruleId.startsWith(p)) ?? '';
    const bPrefix = Object.keys(priority).find((p) => b.ruleId.startsWith(p)) ?? '';
    return (priority[aPrefix] ?? 99) - (priority[bPrefix] ?? 99);
  });
}

export {DEFAULT_VEGA_LITE_ACCESSIBILITY_RULES};
