import type {Reference} from './references.js';

export type AccessibilityIssueSeverity = 'info' | 'warning' | 'error';

export interface AccessibilityIssue {
  ruleId: string;
  severity: AccessibilityIssueSeverity;
  message: string;
  evidence: Record<string, unknown>;
  jsonPointer: string;
  suggestion: string;
  /**
   * Optional per-issue references. Use when an issue cites a more
   * specific source than the rule as a whole — e.g. a text-AA
   * contrast failure cites WCAG SC 1.4.3 specifically, while the
   * rule itself lists all three contrast criteria (1.4.3, 1.4.6, 1.4.11).
   *
   * When omitted, callers should fall back to the parent rule's
   * `references` array.
   */
  references?: Reference[];
}

export interface AccessibilityRule {
  id: string;
  description: string;
  /**
   * Papers, standards, and authoritative sources that ground this
   * rule in published research. Drives the "Based on:" footer in
   * warning tooltips and the references view.
   *
   * Imported from `./references.ts`; see that file for the full catalog.
   */
  references: Reference[];
  evaluate: (spec: Record<string, any>) => AccessibilityIssue[];
}