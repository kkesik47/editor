import * as React from 'react';
import {ChevronDown, ChevronRight} from 'react-feather';
import stringify from 'json-stringify-pretty-compact';
import {parse as parseJSONC} from 'jsonc-parser';

import type {AccessibilityIssue} from '../../features/accessibility/types.js';
import type {Reference} from '../../features/accessibility/references.js';
import {PREVIEW_BUILDERS} from '../../features/accessibility/previewSvgs.js';
import {resolveIssueReferences} from '../../features/accessibility/resolveIssueReferences.js';
import {
  getApplicableRecommendations,
  describeCvdRecommendation,
  type Recommendation,
  type VegaLiteSpec,
} from '../../features/accessibility/recommendations/index.js';
import {useAppContext} from '../../context/app-context.js';
import './index.css';

interface AccessibilityPaneRendererProps {
  issues: AccessibilityIssue[];
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * An issue paired with its index in the original, unpartitioned
 * `accessibilityIssues` array.
 *
 * Why we carry the original index: the heatmap builds each issue's
 * key from its position in the FLAT issues array, but this pane
 * splits issues into warnings/suggestions sections. If we keyed off
 * the per-section index, the same issue would get a different key on
 * each surface and the heatmap ↔ pane matching (hover highlight and
 * click-to-scroll) would silently fail. Threading the original index
 * through keeps both surfaces computing the identical key.
 */
interface IndexedIssue {
  issue: AccessibilityIssue;
  originalIndex: number;
}

/**
 * Partition issues by severity, preserving each issue's original
 * index. Order within each group is preserved from the input —
 * `evaluateVegaLiteAccessibility` already sorts by rule priority, so
 * we want to keep that ordering inside each group.
 */
function partitionBySeverity(issues: AccessibilityIssue[]): {
  warnings: IndexedIssue[];
  suggestions: IndexedIssue[];
} {
  const warnings: IndexedIssue[] = [];
  const suggestions: IndexedIssue[] = [];

  issues.forEach((issue, originalIndex) => {
    if (issue.severity === 'warning' || issue.severity === 'error') {
      warnings.push({issue, originalIndex});
    } else {
      // 'info' issues are framed as suggestions in the UI.
      suggestions.push({issue, originalIndex});
    }
  });

  return {warnings, suggestions};
}

/**
 * Generate a stable key per issue.
 *
 * The combination of `ruleId` + `jsonPointer` is unique in practice:
 * each rule emits at most one issue per JSON pointer. Appending the
 * index guards against any future duplicates without affecting
 * scroll-position stability in the common case.
 *
 * NB: this MUST stay identical to the heatmap's `issueKey`
 * (src/features/accessibility/heatmap/issueKey.ts) — the two are
 * matched against each other to coordinate hover and click-jump.
 */
function issueKey(issue: AccessibilityIssue, index: number): string {
  return `${issue.ruleId}|${issue.jsonPointer}|${index}`;
}

// ─── Sub-components ──────────────────────────────────────────────

/**
 * Collapsible "References" section listing the full APA citations
 * with clickable DOI links.
 *
 * The collapsed state is just "References (N) ▸" — the inline
 * citations already appear in the message above, so the toggle
 * doesn't need to repeat the short citations. Expanding reveals
 * the full bibliographic entries with type badges and links
 * opening in a new tab.
 *
 * Renders nothing when there are no references, so cards stay
 * visually clean for any rule that doesn't have scholarly backing.
 */
function IssueReferences({references}: {references: Reference[]}) {
  const [expanded, setExpanded] = React.useState(false);

  if (references.length === 0) return null;

  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div className="a11y-issue-references">
      <button
        type="button"
        className="a11y-issue-references-toggle"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-label={expanded ? 'Hide reference details' : 'Show reference details'}
      >
        <Chevron size={12} aria-hidden="true" />
        <span className="a11y-issue-references-summary">References ({references.length})</span>
      </button>
      {expanded && (
        <ul className="a11y-issue-references-list">
          {references.map((ref) => (
            <li key={ref.id} className="a11y-issue-reference">
              <a
                href={ref.url}
                target="_blank"
                rel="noopener noreferrer"
                className="a11y-issue-reference-link"
              >
                {ref.fullCitation}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Recommendations section — actionable, machine-applicable fixes.
 *
 * Each recommendation is rendered as a button with a label and a
 * trade-off description. Clicking applies the fix to a clone of the
 * current spec and pushes the result back to the editor, which
 * triggers a re-parse and a re-run of the accessibility evaluator.
 *
 * Renders nothing when no recommendations apply, so cards for rules
 * without registered recommendations look the same as before.
 */
function IssueRecommendations({
  issue,
  recommendations,
  onApply,
}: {
  issue: AccessibilityIssue;
  recommendations: Recommendation[];
  onApply: (rec: Recommendation, issue: AccessibilityIssue) => void;
}) {
  if (recommendations.length === 0) return null;

  return (
    <div className="a11y-issue-recommendations">
      <h4 className="a11y-issue-recommendations-header">Recommendations:</h4>
      <ul className="a11y-recommendation-list">
        {recommendations.map((rec) => (
          <li key={rec.id}>
            <button
              type="button"
              className="a11y-recommendation"
              onClick={() => onApply(rec, issue)}
            >
              <strong className="a11y-recommendation-label">{rec.label}</strong>
              <span className="a11y-recommendation-description">
                {describeCvdRecommendation(rec, issue)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One issue card.
 *
 * Shows JSON pointer + rule ID at the top, the message with inline
 * APA citations, any applicable preview SVGs, the actionable
 * recommendations (if any), and a collapsible "References" section
 * listing full citations with clickable DOI links.
 *
 * Heatmap coordination:
 *   - `isHovered` paints a soft severity-coloured wash while the
 *     matching heatmap blob is hovered.
 *   - `isFocused` plays a one-shot flash when the matching blob is
 *     clicked (paired with a scroll-into-view in the parent).
 *   - `cardRef` registers this card's DOM node with the parent so it
 *     can be scrolled into view by key.
 *   - `data-issue-key` is mainly a debugging aid (lets you find a
 *     card in the DOM by key), harmless to keep.
 */
function IssueCard({
  issue,
  cardKey,
  isHovered,
  isFocused,
  cardRef,
  recommendations,
  onApplyRecommendation,
}: {
  issue: AccessibilityIssue;
  cardKey: string;
  isHovered: boolean;
  isFocused: boolean;
  cardRef: (el: HTMLLIElement | null) => void;
  recommendations: Recommendation[];
  onApplyRecommendation: (rec: Recommendation, issue: AccessibilityIssue) => void;
}) {
  const severityClass =
    issue.severity === 'warning' || issue.severity === 'error' ? 'severity-warning' : 'severity-info';

  // Resolved once and threaded both into the message (as inline
  // citations) and into the IssueReferences component (for the
  // expandable full-citation list).
  const references = resolveIssueReferences(issue);

  // Collect any previews that apply to this issue. `PREVIEW_BUILDERS`
  // returns an empty string when the issue doesn't match a given
  // preview type, so the filter keeps only the ones with real content.
  const previews = PREVIEW_BUILDERS.map(({key, alt, build}) => ({key, alt, src: build(issue)})).filter(
    (p) => p.src.length > 0,
  );

  const classes = ['a11y-issue', severityClass];
  if (isHovered) classes.push('is-hovered');
  if (isFocused) classes.push('is-focused');

  return (
    <li ref={cardRef} data-issue-key={cardKey} className={classes.join(' ')}>
      <div className="a11y-issue-header">
        <span className="a11y-issue-pointer">{issue.jsonPointer || '/'}</span>
        <span className="a11y-issue-rule-id">{issue.ruleId}</span>
      </div>
      <p className="a11y-issue-message">{issue.message}</p>
      {previews.length > 0 && (
        <div className="a11y-issue-previews">
          {previews.map(({key, alt, src}) => (
            <img key={key} src={src} alt={alt} />
          ))}
        </div>
      )}
      <IssueRecommendations
        issue={issue}
        recommendations={recommendations}
        onApply={onApplyRecommendation}
      />
      <IssueReferences references={references} />
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
  const {state, setState} = useAppContext();
  const {warnings, suggestions} = partitionBySeverity(issues);

  // ── Parse the current editor spec once per render ─────────────
  //
  // We need the parsed spec to (a) ask which recommendations apply
  // and (b) hand it to a recommendation's apply() function. Parsing
  // it once at the top is cheaper than re-parsing inside every
  // IssueCard and keeps the parse-error logging in one place.
  const currentSpec: VegaLiteSpec | null = React.useMemo(() => {
    if (!state.editorString) {
      // eslint-disable-next-line no-console
      console.debug('[a11y-recs] editorString is empty');
      return null;
    }
    try {
      const parsed = parseJSONC(state.editorString) as VegaLiteSpec;
      return parsed;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.debug('[a11y-recs] failed to parse editorString', err);
      return null;
    }
  }, [state.editorString]);

  // ── Apply a recommendation: clone, mutate, push back to editor ─
  //
  // The recommendation's apply() function returns a NEW spec object;
  // we stringify it with the same pretty-printer the rest of the app
  // uses and set both editorString and parse=true so the existing
  // pipeline re-evaluates everything (issues, decorations, markers).
  const applyRecommendation = React.useCallback(
    (rec: Recommendation, issue: AccessibilityIssue) => {
      if (!currentSpec) {
        // eslint-disable-next-line no-console
        console.warn('[a11y-recs] cannot apply: no parsed spec');
        return;
      }
      try {
        const newSpec = rec.apply(issue, currentSpec);
        const newString = stringify(newSpec);
        setState((s) => ({...s, editorString: newString, parse: true}));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[a11y-recs] apply failed', err);
      }
    },
    [currentSpec, setState],
  );

  // ── Heatmap ↔ pane coordination ───────────────────────────────
  //
  // Map from card key → DOM node, populated via callback refs on each
  // IssueCard. Lets us scroll a card into view by key without
  // re-rendering the list. A plain ref-held Map is enough here: it's
  // mutated in callback refs (not during render) and only read inside
  // an effect, so it never needs to trigger a re-render itself.
  const cardRefs = React.useRef(new Map<string, HTMLLIElement>());

  // Hover keys paint a soft wash on matching cards (driven by the
  // heatmap mouse-over). Focus key drives a one-shot scroll + flash
  // (driven by clicking a heatmap blob). Both are read off context.
  const hoveredIssueKeys = state.hoveredIssueKeys ?? [];
  const focusedIssueKey = state.focusedIssueKey ?? null;

  // Scroll the focused card into view, then clear the focus token so a
  // repeat click on the same blob fires the effect again (without the
  // clear, state wouldn't change on a second identical click and the
  // effect would not re-run).
  //
  // `block: 'nearest'` means we only scroll when the card is actually
  // off-screen — no jolt if it's already visible. The requestAnimation-
  // Frame defers one frame so the pane (which may have just been
  // revealed via `debugPane: true` on the same click) has laid out
  // before we measure. The 1.2s timeout matches the flash animation so
  // the highlight plays fully before the class is removed.
  React.useEffect(() => {
    if (!focusedIssueKey) return undefined;

    const raf = requestAnimationFrame(() => {
      const el = cardRefs.current.get(focusedIssueKey);
      if (el) el.scrollIntoView({behavior: 'smooth', block: 'nearest'});
    });

    const timer = setTimeout(() => {
      setState((s) => (s.focusedIssueKey === focusedIssueKey ? {...s, focusedIssueKey: null} : s));
    }, 1200);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [focusedIssueKey, setState]);

  // ── Pre-compute recommendations per issue ─────────────────────
  //
  // Done at this level so each IssueCard receives its list as a
  // prop instead of re-running the lookup on every render. Keyed by
  // the issue's ORIGINAL index so the keys match everywhere.
  const recommendationsByKey = React.useMemo(() => {
    const map = new Map<string, Recommendation[]>();
    if (!currentSpec) return map;

    [...warnings, ...suggestions].forEach(({issue, originalIndex}) => {
      const key = issueKey(issue, originalIndex);
      const recs = getApplicableRecommendations(issue, currentSpec);
      map.set(key, recs);
    });

    return map;
  }, [warnings, suggestions, currentSpec]);

  if (warnings.length === 0 && suggestions.length === 0) {
    return (
      <div className="accessibility-pane">
        <EmptyState />
      </div>
    );
  }

  // Build a card from an indexed issue. Shared by both sections so the
  // ref/hover/focus wiring stays identical and can't drift.
  const renderCard = ({issue, originalIndex}: IndexedIssue) => {
    const key = issueKey(issue, originalIndex);
    return (
      <IssueCard
        key={key}
        cardKey={key}
        issue={issue}
        isHovered={hoveredIssueKeys.includes(key)}
        isFocused={focusedIssueKey === key}
        cardRef={(el) => {
          if (el) cardRefs.current.set(key, el);
          else cardRefs.current.delete(key);
        }}
        recommendations={recommendationsByKey.get(key) ?? []}
        onApplyRecommendation={applyRecommendation}
      />
    );
  };

  return (
    <div className="accessibility-pane">
      {warnings.length > 0 && (
        <section className="a11y-section">
          <SectionHeaderWarning title="Warnings" count={warnings.length} />
          <ul className="a11y-issue-list">{warnings.map(renderCard)}</ul>
        </section>
      )}
      {suggestions.length > 0 && (
        <section className="a11y-section">
          <SectionHeaderSuggestion title="Suggestions" count={suggestions.length} />
          <ul className="a11y-issue-list">{suggestions.map(renderCard)}</ul>
        </section>
      )}
    </div>
  );
};

export default AccessibilityPaneRenderer;