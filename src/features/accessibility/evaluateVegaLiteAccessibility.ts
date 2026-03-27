import {AccessibilityIssue, AccessibilityRule} from './types.js';
import {colorRiskRule} from './rules/colorRiskRule.js';
import {colorblindSafetyRule} from './rules/colorblindSafetyRule.js';

const DEFAULT_VEGA_LITE_ACCESSIBILITY_RULES: AccessibilityRule[] = [
  colorRiskRule,
  colorblindSafetyRule,
];

export function evaluateVegaLiteAccessibility(
  spec: Record<string, any>,
  rules: AccessibilityRule[] = DEFAULT_VEGA_LITE_ACCESSIBILITY_RULES,
): AccessibilityIssue[] {
  return rules.flatMap((rule) => rule.evaluate(spec));
}

export {DEFAULT_VEGA_LITE_ACCESSIBILITY_RULES};
