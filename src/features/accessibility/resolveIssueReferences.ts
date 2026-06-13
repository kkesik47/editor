/**
 * resolveIssueReferences.ts
 *
 * Single source of truth for "which scientific sources back this
 * accessibility issue?". Used by both the Accessibility pane and
 * the Monaco hover tooltip so they always show the same citations.
 *
 * Resolution order (most-specific to least-specific):
 *
 *   1. Issue-level `references` - most specific. Used when a single
 *      rule can fire for materially different reasons that warrant
 *      different citations. Example: contrastRule emits text-AA
 *      issues citing WCAG 1.4.3, text-AAA issues citing 1.4.6, and
 *      non-text issues citing 1.4.11 - each issue carries its own
 *      precise reference, while the rule lists all three.
 *
 *   2. Rule-level `references` - found by matching the issue's
 *      `ruleId` against each registered rule. Match logic accepts
 *      either an exact equal (`issue.ruleId === rule.id`) or a
 *      hierarchical prefix (`issue.ruleId.startsWith(rule.id + ':')`).
 *
 *   3. Empty array - if no rule matches, no references are shown.
 *      The renderer should handle this gracefully (hiding the
 *      "Based on:" line entirely).
 *
 * Special case - colorRiskRule:
 *
 *   The rule's id is 'vl-a11y-color-risk-engine', but its issues
 *   inherit their ID prefix from the knowledge-base JSON file,
 *   which uses 'vl-a11y-color-risk-rules' as its `id` field.
 *   The two strings don't share a prefix, so the normal hierarchical
 *   lookup misses them. ISSUE_PREFIX_TO_RULE_ID bridges the gap.
 *   If similar divergences appear in future rules, add them here.
 */

import type {AccessibilityIssue} from './types.js';
import type {Reference} from './references.js';
import {DEFAULT_VEGA_LITE_ACCESSIBILITY_RULES} from './evaluateVegaLiteAccessibility.js';

/**
 * Bridge map for rules whose emitted issue IDs don't share a prefix
 * with their `rule.id`. Keys are issue-ID prefixes; values are the
 * corresponding `rule.id`.
 */
const ISSUE_PREFIX_TO_RULE_ID: Record<string, string> = {
  'vl-a11y-color-risk-rules': 'vl-a11y-color-risk-engine',
};

/**
 * Look up references for an issue, falling back through the
 * resolution chain described in the module header.
 */
export function resolveIssueReferences(issue: AccessibilityIssue): Reference[] {
  // 1. Per-issue references win when present.
  if (issue.references && issue.references.length > 0) {
    return issue.references;
  }

  // 2. Direct lookup against each rule's id (exact or hierarchical).
  for (const rule of DEFAULT_VEGA_LITE_ACCESSIBILITY_RULES) {
    if (issue.ruleId === rule.id || issue.ruleId.startsWith(rule.id + ':')) {
      return rule.references;
    }
  }

  // 3. Bridge map for rules whose issue-prefix differs from rule.id.
  for (const [issuePrefix, ruleId] of Object.entries(ISSUE_PREFIX_TO_RULE_ID)) {
    if (issue.ruleId === issuePrefix || issue.ruleId.startsWith(issuePrefix + ':')) {
      const rule = DEFAULT_VEGA_LITE_ACCESSIBILITY_RULES.find((r) => r.id === ruleId);
      if (rule) return rule.references;
    }
  }

  return [];
}
