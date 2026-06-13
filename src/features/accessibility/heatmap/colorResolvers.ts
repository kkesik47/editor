/**
 * colorResolvers.ts
 *
 * Locates the colour- and contrast-related rules on the rendered chart.
 *
 * Every colour-scale rule - colourblind safety, colour risk, lightness
 * contrast, perceptual uniformity, colour-only encoding, and non-text
 * contrast - is fundamentally about the colours a scale assigns to the
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
import {collectAbsoluteBoxes, collectDataMarkBoxes, unionBounds, SceneItem} from './boundingBox.js';
import type {IssueResolver, ResolverContext} from './resolvers.js';
import {channelFromLabel, channelFromPointer, locateTextElement, type TextElementKind} from './textElements.js';
import {markGroupIndicesForIssue, collectMarkGroupBounds, clipBoxesToMarkGroups} from './viewScope.js';

/**
 * Identify which channel a legend represents by what its symbol
 * entries vary in. Vega-Lite renders one legend per scale; symbols
 * inside differ along the encoded axis (fill for colour, radius for
 * size, glyph for shape), so the varying property names the channel.
 *
 * Used to filter legends to those that match the channel an issue
 * is about - so a /encoding/color issue doesn't paint blobs on the
 * sibling size or shape legend.
 */
type LegendChannel = 'color' | 'size' | 'shape' | 'opacity' | 'unknown';

function detectLegendChannel(legend: SceneItem): LegendChannel {
  const symbols: SceneItem[] = [];
  const collectSymbols = (item: SceneItem): void => {
    if (item.marktype === 'symbol' && Array.isArray(item.items)) {
      symbols.push(...item.items);
    }
    item.items?.forEach(collectSymbols);
  };
  collectSymbols(legend);

  // A legend with one entry can't be characterised by what varies;
  // fall through to 'unknown' rather than misclassifying.
  if (symbols.length < 2) return 'unknown';

  const distinct = (key: 'fill' | 'size' | 'shape' | 'opacity') =>
    new Set(symbols.map((s) => s[key]).filter((v) => v != null)).size;

  if (distinct('fill') > 1) return 'color';
  if (distinct('size') > 1) return 'size';
  if (distinct('shape') > 1) return 'shape';
  if (distinct('opacity') > 1) return 'opacity';
  return 'unknown';
}

/**
 * Walk the scenegraph and collect legend-entry boxes only from
 * legends whose channel is in `keepChannels`.
 */
function collectLegendEntriesByChannel(root: SceneItem, keepChannels: Set<LegendChannel>): BoundingBox[] {
  const out: BoundingBox[] = [];

  const visit = (item: SceneItem, offsetX: number, offsetY: number, inMatchingLegend: boolean): void => {
    let nextInside = inMatchingLegend;

    if (item.role === 'legend') {
      // Skip the entire subtree of any legend we don't want. Legends
      // don't nest, so it's safe to bail out here.
      if (!keepChannels.has(detectLegendChannel(item))) return;
      nextInside = true;
    }

    if (inMatchingLegend && item.role === 'legend-entry' && item.bounds) {
      const b = item.bounds;
      out.push({
        x: b.x1 + offsetX,
        y: b.y1 + offsetY,
        width: b.x2 - b.x1,
        height: b.y2 - b.y1,
      });
    }

    const childX = offsetX + (typeof item.x === 'number' ? item.x : 0);
    const childY = offsetY + (typeof item.y === 'number' ? item.y : 0);
    item.items?.forEach((child) => visit(child, childX, childY, nextInside));
  };

  visit(root, 0, 0, false);
  return out;
}

/**
 * True when the issue's pointer addresses a `condition.value`
 * fallback - i.e. a `/value` whose sibling node carries a
 * `condition`. Those colours only paint when the predicate fails
 * (default-empty selections match everything, so the marks/legend
 * render with the condition's scale, not this value). Surfacing a
 * heatmap blob on the rendered chart for them would point at
 * elements that don't actually show the colour. The issue still
 * appears in Monaco and the accessibility pane, where it belongs.
 */
function isConditionalValueFallback(pointer: string, spec: Record<string, unknown>): boolean {
  if (!pointer.endsWith('/value')) return false;
  const segments = pointer.split('/').filter(Boolean);
  segments.pop(); // drop 'value'
  let node: any = spec;
  for (const seg of segments) {
    if (node == null || typeof node !== 'object') return false;
    node = node[seg];
  }
  return node?.condition != null;
}

export const colorScaleResolver: IssueResolver = (issue, ctx) => {
  if (isConditionalValueFallback(issue.jsonPointer, ctx.spec)) {
    return {kind: 'mark', boxes: []};
  }

  const root = ctx.scenegraphRoot;
  const allowedGroups = markGroupIndicesForIssue(issue.jsonPointer, ctx.spec);
  const marks = collectDataMarkBoxes(root, allowedGroups);

  let legendBoxes = collectLegendEntriesByChannel(root, new Set(['color']));
  if (allowedGroups !== null) {
    legendBoxes = clipBoxesToMarkGroups(legendBoxes, allowedGroups, collectMarkGroupBounds(root));
  }

  return {kind: 'mark', boxes: [...marks, ...legendBoxes]};
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
export const contrastResolver: IssueResolver = (issue, ctx) => {
  const evidence = (issue.evidence ?? {}) as Record<string, unknown>;

  if (evidence.elementType === 'non-text') {
    return colorScaleResolver(issue, ctx);
  }

  const label = typeof evidence.elementLabel === 'string' ? evidence.elementLabel : '';
  const elementKind = kindFromContrastLabel(label);
  if (!elementKind) return {kind: 'text', boxes: []};

  const channel = channelFromPointer(issue.jsonPointer) ?? channelFromLabel(label);
  const allowedGroups = markGroupIndicesForIssue(issue.jsonPointer, ctx.spec);
  return {
    kind: 'text',
    boxes: locateTextElement(elementKind, channel, ctx.scenegraphRoot, allowedGroups),
  };
};
