/**
 * resolvers.ts
 *
 * The framework that maps accessibility issues to regions of the
 * rendered chart. This mapping is the heart of the heatmap.
 *
 * An issue carries a Vega-LITE json pointer (e.g. /encoding/color).
 * The scenegraph is the compiled VEGA tree. There is no structural
 * 1:1 correspondence between the two, so a resolver does NOT "walk
 * the pointer". Instead it interprets what the rule MEANS and finds
 * the matching scene items by their semantic `role` (axis-label,
 * legend-symbol, the data marks driven by a scale, ...).
 *
 * One resolver per rule family, registered below. The registry maps a
 * ruleId to its resolver exactly like the recommendation registry
 * does — including the same hierarchical prefix match, because rules
 * emit sub-category ids (e.g. fontSizeRule's id is 'vl-a11y-font-size'
 * but its issues are 'vl-a11y-font-size:axis.labelFontSize').
 *
 * Adding a resolver for a new rule:
 *   1. Write `<ruleName>Resolver.ts` exporting an IssueResolver.
 *   2. Register it in RESOLVER_REGISTRY below.
 */

import type {AccessibilityIssue} from '../types.js';
import type {BoundingBox, SceneItem} from './boundingBox.js';
import {issueKey} from './issueKey.js';
import {fontSizeResolver} from './fontSizeResolver.js';
import {colorScaleResolver, contrastResolver} from './colorResolvers.js';

// ─── Contract ────────────────────────────────────────────────────

/**
 * Everything a resolver needs to locate an issue on the chart.
 * Bundled into one object so resolver signatures stay stable as we
 * discover we need more context later (resolved scales, config, ...).
 */
export interface ResolverContext {
  /** Root of the runtime scenegraph: view.scenegraph().root. */
  scenegraphRoot: SceneItem;
  /** The Vega-Lite spec the issues were evaluated against. */
  spec: Record<string, unknown>;
}

/**
 * A resolver answers one question: "where on the chart does this
 * issue live?" It returns zero or more boxes. Zero means it could not
 * confidently locate the issue, in which case the overlay draws
 * nothing rather than guessing at the wrong place.
 */
export type IssueResolver = (issue: AccessibilityIssue, ctx: ResolverContext) => BoundingBox[];

/**
 * One drawable region: the box, the issue it came from (so the overlay
 * can colour it by `issue.severity`), and a stable `key` identifying
 * that issue across the chart / editor / pane for hover coordination.
 */
export interface IssueRegion {
  issue: AccessibilityIssue;
  box: BoundingBox;
  key: string;
}

// ─── Registry ────────────────────────────────────────────────────

const RESOLVER_REGISTRY: Record<string, IssueResolver> = {
  'vl-a11y-font-size': fontSizeResolver,

  // Colour-scale rules — all manifest on the coloured marks + legend.
  'vl-a11y-colorblind-safety': colorScaleResolver,
  // colourRiskRule's rule.id and its issue-id prefix differ, so register
  // both forms (same divergence the recommendation registry handles).
  'vl-a11y-color-risk-engine': colorScaleResolver,
  'vl-a11y-color-risk-rules': colorScaleResolver,
  'vl-a11y-lightness-contrast': colorScaleResolver,
  'vl-a11y-perceptual-uniformity': colorScaleResolver,
  'vl-a11y-color-only': colorScaleResolver,

  // Contrast splits internally: non-text → marks/legend, text → text
  // elements (next chunk). One bare key catches every sub-type.
  'vl-a11y-contrast': contrastResolver,
};

/**
 * Find the resolver for an issue's ruleId. Tries an exact match
 * first, then a hierarchical prefix match ('vl-a11y-font-size'
 * matches 'vl-a11y-font-size:axis.labelFontSize'), mirroring
 * getRecommendationsForRule.
 */
function getResolver(ruleId: string): IssueResolver | null {
  if (RESOLVER_REGISTRY[ruleId]) return RESOLVER_REGISTRY[ruleId];

  for (const [prefix, resolver] of Object.entries(RESOLVER_REGISTRY)) {
    if (ruleId.startsWith(prefix + ':')) return resolver;
  }
  return null;
}

// ─── Orchestrator ────────────────────────────────────────────────

/**
 * Turn the current issue list into drawable regions. Issues with no
 * registered resolver are skipped; a resolver returning several boxes
 * (e.g. a config-level font issue covering both axes) yields one
 * region per box so each stays visually tight rather than merged into
 * one chart-spanning rectangle.
 */
export function resolveIssueRegions(issues: AccessibilityIssue[], ctx: ResolverContext): IssueRegion[] {
  const regions: IssueRegion[] = [];

  issues.forEach((issue, index) => {
    const resolver = getResolver(issue.ruleId);
    if (!resolver) return;

    const key = issueKey(issue, index);
    for (const box of resolver(issue, ctx)) {
      regions.push({issue, box, key});
    }
  });

  return regions;
}