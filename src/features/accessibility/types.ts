export type AccessibilityIssueSeverity = 'info' | 'warning' | 'error';

export interface AccessibilityIssue {
  ruleId: string;
  severity: AccessibilityIssueSeverity;
  message: string;
  evidence: Record<string, unknown>;
  jsonPointer: string;
  suggestion: string;
}

export interface AccessibilityRule {
  id: string;
  description: string;
  evaluate: (spec: Record<string, any>) => AccessibilityIssue[];
}
