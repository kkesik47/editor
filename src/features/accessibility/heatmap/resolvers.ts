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
 * Kind of region: 'mark' for data marks and legend symbols (visual
 * marks); 'text' for axis/legend/title labels and titles. Drives
 * clustering — marks inflate before the overlap test so dense
 * scatters merge into regional blobs; text stays tight so labels
 * and titles never bleed into one another.
 */
export type RegionKind = 'mark' | 'text';

/**
 * A resolver's answer: which kind of element it located, and the
 * boxes themselves. All boxes from one resolver call share a kind
 * (a single issue concerns either marks or text, never both).
 */
export interface ResolvedRegion {
  kind: RegionKind;
  boxes: BoundingBox[];
}

/**
 * A resolver answers one question: "where on the chart does this
 * issue live?" It returns the kind of element it targeted plus
 * zero or more boxes. Zero boxes means it could not confidently
 * locate the issue, in which case the overlay draws nothing rather
 * than guessing at the wrong place.
 */
export type IssueResolver = (issue: AccessibilityIssue, ctx: ResolverContext) => ResolvedRegion;

/**
 * One drawable region: the box, the issue it came from, a stable
 * `key` for cross-surface coordination, and the region kind so
 * clustering can treat marks and text differently.
 */
export interface IssueRegion {
  issue: AccessibilityIssue;
  box: BoundingBox;
  key: string;
  kind: RegionKind;
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
    const {kind, boxes} = resolver(issue, ctx);
    for (const box of boxes) {
      regions.push({issue, box, key, kind});
    }
  });

  return regions;
}