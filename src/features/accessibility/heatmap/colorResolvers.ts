/**
 * colorResolvers.ts
 *
 * Locates the colour- and contrast-related rules on the rendered chart.
 *
 * Every colour-scale rule — colourblind safety, colour risk, lightness
 * contrast, perceptual uniformity, colour-only encoding, and non-text
 * contrast — is fundamentally about the colours a scale assigns to the
 * data. Those colours appear in exactly two places:
 *
 *   1. the data marks themselves (role 'mark'), and
 *   2. the legend that documents the scale (role 'legend').
 *
 * So they share ONE resolver that highlights both. We start coarse: a
 * single box over the mark group (rather than one box per mark) and a
 * box over each legend. That reads clearly as "this scale's colours are
 * the problem"; per-mark precision can come later.
 *
 * Contrast is the one rule that isn't purely about colour: it also
 * covers TEXT contrast (axis/legend/title text vs. background). Its
 * issues carry evidence.elementType ('non-text' vs 'text').
 * contrastResolver branches on that:
 *   non-text → the coloured marks / legend (colour-scale resolver)
 *   text     → the offending text element (shared with fontSize)
 */

import type {AccessibilityIssue} from '../types.js';
import type {BoundingBox} from './boundingBox.js';
import {collectAbsoluteBoxes} from './boundingBox.js';
import type {IssueResolver, ResolverContext} from './resolvers.js';
import {channelFromLabel, channelFromPointer, locateTextElement, type TextElementKind} from './textElements.js';

/**
 * Highlight the coloured data marks and the legend(s) that show the
 * scale. Shared by all colour-scale rules.
 */
export const colorScaleResolver: IssueResolver = (_issue: AccessibilityIssue, ctx: ResolverContext): BoundingBox[] => {
  const root = ctx.scenegraphRoot;

  // The data marks coloured by the scale (one union box per mark group).
  const marks = collectAbsoluteBoxes(root, (item) => item.role === 'mark');

  // The legend(s) documenting the scale's colours.
  const legends = collectAbsoluteBoxes(root, (item) => item.role === 'legend');

  return [...marks, ...legends];
};

/**
 * Map a text-contrast element label to a text-element kind. Contrast
 * issues don't carry configKey/role like fontSize does, so we read the
 * human label, e.g. "Chart title", "X-axis labels", "Color legend title".
 */
function kindFromContrastLabel(label: string): TextElementKind | null {
  const l = label.toLowerCase();
  if (l === 'chart title') return 'chart-title';
  if (l.includes('axis')) return l.includes('title') ? 'axis-title' : 'axis-label';
  if (l.includes('legend')) return l.includes('title') ? 'legend-title' : 'legend-label';
  return null;
}

/**
 * Route a contrast issue to the right place: non-text contrast lands on
 * the coloured marks/legend; text contrast lands on the offending text
 * element (axis labels/titles, legend text, or the chart title).
 */
export const contrastResolver: IssueResolver = (issue: AccessibilityIssue, ctx: ResolverContext): BoundingBox[] => {
  const evidence = (issue.evidence ?? {}) as Record<string, unknown>;

  if (evidence.elementType === 'non-text') {
    return colorScaleResolver(issue, ctx);
  }

  // Text contrast — same target elements as fontSize.
  const label = String(evidence.elementLabel ?? '');
  const kind = kindFromContrastLabel(label);
  if (!kind) return [];

  const channel = channelFromPointer(issue.jsonPointer) ?? channelFromLabel(label);
  return locateTextElement(kind, channel, ctx.scenegraphRoot);
};