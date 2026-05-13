import * as React from 'react';

import type {AccessibilityIssue, AccessibilityIssueSeverity} from '../../features/accessibility/types.js';
import {PREVIEW_BUILDERS} from '../../features/accessibility/previewSvgs.js';
import './index.css';

interface AccessibilityPaneRendererProps {
  issues: AccessibilityIssue[];
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Partition issues by severity. Order within each group is preserved
 * from the input — `evaluateVegaLiteAccessibility` already sorts by
 * rule priority, so we want to keep that ordering inside each group.
 */
function partitionBySeverity(issues: AccessibilityIssue[]): {
  warnings: AccessibilityIssue[];
  suggestions: AccessibilityIssue[];
} {
  const warnings: AccessibilityIssue[] = [];
  const suggestions: AccessibilityIssue[] = [];

  for (const issue of issues) {
    if (issue.severity === 'warning' || issue.severity === 'error') {
      warnings.push(issue);
    } else {
      // 'info' issues are framed as suggestions in the UI.
      suggestions.push(issue);
    }
  }

  return {warnings, suggestions};
}

/**
 * Generate a stable React key per issue.
 *
 * The combination of `ruleId` + `jsonPointer` is unique in practice:
 * each rule emits at most one issue per JSON pointer. Appending the
 * array index guards against any future duplicates without affecting
 * scroll-position stability in the common case.
 */
function issueKey(issue: AccessibilityIssue, index: number): string {
  return `${issue.ruleId}|${issue.jsonPointer}|${index}`;
}

// ─── Sub-components ──────────────────────────────────────────────

/**
 * One issue card. Shows JSON pointer + rule ID at the top, the message
 * and suggestion as prose, and any applicable preview SVGs underneath.
 */
function IssueCard({issue}: {issue: AccessibilityIssue}) {
  const severityClass =
    issue.severity === 'warning' || issue.severity === 'error' ? 'severity-warning' : 'severity-info';

  // Collect any previews that apply to this issue. `PREVIEW_BUILDERS`
  // returns an empty string when the issue doesn't match a given
  // preview type, so the filter keeps only the ones with real content.
  const previews = PREVIEW_BUILDERS.map(({key, alt, build}) => ({key, alt, src: build(issue)})).filter(
    (p) => p.src.length > 0,
  );

  return (
    <li className={`a11y-issue ${severityClass}`}>
      <div className="a11y-issue-header">
        <span className="a11y-issue-pointer">{issue.jsonPointer || '/'}</span>
        <span className="a11y-issue-rule-id">{issue.ruleId}</span>
      </div>
      <p className="a11y-issue-message">{issue.message}</p>
      {issue.suggestion && (
        <p className="a11y-issue-suggestion">
          <strong>Suggestion:</strong> {issue.suggestion}
        </p>
      )}
      {previews.length > 0 && (
        <div className="a11y-issue-previews">
          {previews.map(({key, alt, src}) => (
            <img key={key} src={src} alt={alt} />
          ))}
        </div>
      )}
    </li>
  );
}

/** A section header with title and total count. */
function SectionHeaderWarning({title, count}: {title: string; count: number}) {
  return (
    <h3 className="a11y-section-header">
      <span>{title}</span>
      <span className="a11y-section-warning-count">({count})</span>
    </h3>
  );
}

function SectionHeaderSuggestion({title, count}: {title: string; count: number}) {
  return (
    <h3 className="a11y-section-header">
      <span>{title}</span>
      <span className="a11y-section-suggestion-count">({count})</span>
    </h3>
  );
}

/**
 * Empty state — shown when the linter produced no issues.
 *
 * Honest framing: we tell the user we found nothing AND that the
 * linter only covers what it knows how to check, so absence of
 * issues doesn't equal full accessibility.
 */
function EmptyState() {
  return (
    <div className="a11y-empty">
      <p className="a11y-empty-headline">No accessibility issues detected by the linter.</p>
      <p className="a11y-empty-note">
        Note: this tool checks WCAG criteria and common perceptual design issues. Not all accessibility concerns can be
        detected automatically.
      </p>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────

const AccessibilityPaneRenderer: React.FC<AccessibilityPaneRendererProps> = ({issues}) => {
  const {warnings, suggestions} = partitionBySeverity(issues);

  if (warnings.length === 0 && suggestions.length === 0) {
    return (
      <div className="accessibility-pane">
        <EmptyState />
      </div>
    );
  }

  return (
    <div className="accessibility-pane">
      {warnings.length > 0 && (
        <section className="a11y-section">
          <SectionHeaderWarning title="Warnings" count={warnings.length} />
          <ul className="a11y-issue-list">
            {warnings.map((issue, i) => (
              <IssueCard key={issueKey(issue, i)} issue={issue} />
            ))}
          </ul>
        </section>
      )}
      {suggestions.length > 0 && (
        <section className="a11y-section">
          <SectionHeaderSuggestion title="Suggestions" count={suggestions.length} />
          <ul className="a11y-issue-list">
            {suggestions.map((issue, i) => (
              <IssueCard key={issueKey(issue, i)} issue={issue} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};

export default AccessibilityPaneRenderer;
