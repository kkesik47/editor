import {AccessibilityIssue, AccessibilityRule} from './types.js';
import {redGreenRiskRule} from './rules/redGreenContrastRule.js';

const DEFAULT_VEGA_LITE_ACCESSIBILITY_RULES: AccessibilityRule[] = [redGreenRiskRule];

export function evaluateVegaLiteAccessibility(
  spec: Record<string, any>,
  rules: AccessibilityRule[] = DEFAULT_VEGA_LITE_ACCESSIBILITY_RULES,
): AccessibilityIssue[] {
  return rules.flatMap((rule) => rule.evaluate(spec));
}

export {DEFAULT_VEGA_LITE_ACCESSIBILITY_RULES};
