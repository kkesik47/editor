/**
 * recommendations/registry.ts
 *
 * Maps each rule ID to its list of recommendations, and provides the
 * lookup the accessibility pane uses to populate the recommendations
 * section of each issue card.
 *
 * Adding recommendations for a new rule:
 *   1. Create `<ruleName>Recs.ts` exporting an array of Recommendation.
 *   2. Register it in RECOMMENDATION_REGISTRY below.
 *
 * Matching logic for rule IDs:
 *   Rules emit issues whose `ruleId` can be exactly the rule's `id`
 *   or prefixed with a sub-category (e.g. 'vl-a11y-colorblind-safety'
 *   emits issues like 'vl-a11y-colorblind-safety:protanopia'). We
 *   match on prefix so all sub-category issues share the same
 *   recommendations.
 *
 * Special case — colorRiskRule:
 *   Same divergence as in `resolveIssueReferences.ts`: the rule's
 *   `id` field is 'vl-a11y-color-risk-engine', but its issues use
 *   the prefix 'vl-a11y-color-risk-rules' (inherited from the
 *   knowledge-base JSON file's `id`). We register both keys so the
 *   prefix lookup matches whichever form the issue carries.
 */

import type {AccessibilityIssue} from '../types.js';
import type {Recommendation, VegaLiteSpec} from './types.js';
import {colorblindSafetyRecommendations} from './colorblindSafetyRecs.js';
import {colorRiskRecommendations} from './colorRiskRecs.js';

const RECOMMENDATION_REGISTRY: Record<string, Recommendation[]> = {
  'vl-a11y-colorblind-safety': colorblindSafetyRecommendations,
  // Both the rule.id and the issue-ID prefix are mapped to the same
  // recommendations array — see the special-case note above.
  'vl-a11y-color-risk-engine': colorRiskRecommendations,
  'vl-a11y-color-risk-rules': colorRiskRecommendations,
};

/**
 * Find the registered recommendations whose rule-ID prefix matches
 * the given issue's `ruleId`. Returns an empty array if none match.
 */
export function getRecommendationsForRule(ruleId: string): Recommendation[] {
  // Exact match first (cheap path).
  if (RECOMMENDATION_REGISTRY[ruleId]) {
    return RECOMMENDATION_REGISTRY[ruleId];
  }

  // Hierarchical prefix match (e.g. 'vl-a11y-colorblind-safety:protanopia'
  // or 'vl-a11y-color-risk-rules:red-green').
  for (const [prefix, recs] of Object.entries(RECOMMENDATION_REGISTRY)) {
    if (ruleId.startsWith(prefix + ':')) return recs;
  }

  return [];
}

/**
 * Get all recommendations that apply to the given issue in the given
 * spec. This is the main entry point the accessibility pane calls
 * when rendering the recommendations section of an issue card.
 */
export function getApplicableRecommendations(
  issue: AccessibilityIssue,
  spec: VegaLiteSpec,
): Recommendation[] {
  return getRecommendationsForRule(issue.ruleId).filter((rec) =>
    rec.applicableWhen(issue, spec),
  );
}