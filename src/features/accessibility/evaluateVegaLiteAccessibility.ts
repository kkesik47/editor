import {AccessibilityIssue, AccessibilityRule} from './types.js';
import {colorRiskRule} from './rules/colorRiskRule.js';
import {colorblindSafetyRule} from './rules/colorblindSafetyRule.js';

const DEFAULT_VEGA_LITE_ACCESSIBILITY_RULES: AccessibilityRule[] = [
  colorRiskRule,
  colorblindSafetyRule,
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
  // Collect all jsonPointer prefixes covered by the CVD simulation rule
  const cvdPointers = issues
    .filter((issue) => issue.ruleId.startsWith('vl-a11y-colorblind-safety'))
    .map((issue) => issue.jsonPointer);

  // Keep every issue UNLESS it is a color-risk issue whose pointer
  // falls under a path already covered by the CVD simulation rule
  return issues.filter((issue) => {
    if (!issue.ruleId.startsWith('vl-a11y-color-risk-rules')) {
      return true; // Not a color-risk issue — always keep
    }

    // Check if any CVD simulation issue covers this same scale
    const isCoveredByCvd = cvdPointers.some(
      (cvdPointer) => issue.jsonPointer.startsWith(cvdPointer),
    );

    return !isCoveredByCvd;
  });
}

export function evaluateVegaLiteAccessibility(
  spec: Record<string, any>,
  rules: AccessibilityRule[] = DEFAULT_VEGA_LITE_ACCESSIBILITY_RULES,
): AccessibilityIssue[] {
  const allIssues = rules.flatMap((rule) => rule.evaluate(spec));
  return deduplicateColorIssues(allIssues);
}

export {DEFAULT_VEGA_LITE_ACCESSIBILITY_RULES};