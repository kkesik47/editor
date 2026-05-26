/**
 * issueKey.ts
 *
 * A stable identifier for one accessibility issue, used to coordinate
 * hover state across the three surfaces that show the same issue: the
 * chart overlay (heatmap region), the source editor (highlighted line),
 * and the accessibility pane (issue card).
 *
 * The key must be computed identically everywhere, so it lives in one
 * place. ruleId + jsonPointer is unique in practice (each rule emits at
 * most one issue per pointer); the index guards against any future
 * duplicate without affecting matching in the common case.
 *
 * NB: this mirrors the accessibility pane's own `issueKey`. It is
 * duplicated here (rather than imported from the pane) so the heatmap
 * feature has no dependency on a UI component; if the two ever need to
 * share one definition, this is the canonical copy to converge on.
 */

import type {AccessibilityIssue} from '../types.js';

export function issueKey(issue: AccessibilityIssue, index: number): string {
  return `${issue.ruleId}|${issue.jsonPointer}|${index}`;
}