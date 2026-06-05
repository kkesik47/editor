import type {Reference} from './references.js';

export type AccessibilityIssueSeverity = 'info' | 'warning' | 'error';

/**
 * How the issue should surface in the spec editor.
 *
 *   'underline'     — wavy decoration on the VALUE at the pointer
 *                     PLUS a problems-panel marker. The default
 *                     behaviour for issues that criticise a concrete
 *                     value the author has written.
 *
 *   'underline-key' — wavy decoration on the property KEY at the
 *                     pointer (e.g. just `"y"` rather than the
 *                     entire `{...}` value) plus a problems-panel
 *                     marker. Used when the pointer is an "anchor
 *                     for the fix" rather than the location of a
 *                     written value — underlining the value would
 *                     mark unrelated sibling properties as wrong,
 *                     but underlining the key honestly says "this
 *                     section needs your attention" without making
 *                     any claim about properties inside it.
 *
 *   'marker-only'   — problems-panel marker only, no wavy decoration.
 *                     Use when even the key would be misleading.
 */
export type AccessibilityIssueEditorVisibility =
  | 'underline'
  | 'underline-key'
  | 'marker-only';

export interface AccessibilityIssue {
  ruleId: string;
  severity: AccessibilityIssueSeverity;
  message: string;
  evidence: Record<string, unknown>;
  jsonPointer: string;
  references?: Reference[];

  /**
   * Optional editor surface preference. When omitted, behaves as
   * 'underline' (the historical default). See type docs above.
   */
  editorVisibility?: AccessibilityIssueEditorVisibility;

  /*Before we had recommendation engine, each AccessibilityIssue had a hardcoded
  message suggestion (e.g. switch to viridis)
  Can be removed, but has to be removed from each rule as well to avoid errors*/
  suggestion: string;   
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