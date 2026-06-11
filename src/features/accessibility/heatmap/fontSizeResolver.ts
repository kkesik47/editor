/**
 * fontSizeResolver.ts
 *
 * Locates fontSizeRule issues on the rendered chart.
 *
 * fontSizeRule reports too-small text on five kinds of element, and its
 * issue carries structured data that pins down which one:
 *
 *   evidence.configKey → which family ("axis"/"legend"/"title"/"text")
 *   evidence.role      → "label" vs "title" within that family
 *   evidence.element   → human label like "X-axis labels" (channel hint)
 *   jsonPointer        → the axis channel for encoding-level issues
 *
 * The actual placement on the chart is shared with text-contrast (which
 * targets the same elements) and lives in textElements.ts. This file
 * just translates fontSize evidence into a (kind, channel) pair.
 */

import type {AccessibilityIssue} from '../types.js';
import type {BoundingBox} from './boundingBox.js';
import type {IssueResolver, ResolverContext} from './resolvers.js';
import {channelFromLabel, channelFromPointer, locateTextElement, locateTextMarksInGroups, type TextElementKind} from './textElements.js';
import {markGroupIndicesForIssue} from './viewScope.js';

/** Section of a configKey: "axis.labelFontSize" → "axis". */
function configSection(configKey: unknown): string {
  return typeof configKey === 'string' ? configKey.split('.')[0] : '';
}


/** Map fontSize evidence (config section + label/title role) to a text-element kind. */
function kindFromEvidence(section: string, isTitle: boolean): TextElementKind | null {
  if (section === 'title') return 'chart-title';
  if (section === 'axis') return isTitle ? 'axis-title' : 'axis-label';
  if (section === 'legend') return isTitle ? 'legend-title' : 'legend-label';
  return null;
}

export const fontSizeResolver: IssueResolver = (issue, ctx) => {
  const evidence = (issue.evidence ?? {}) as Record<string, unknown>;
  const section = configSection(evidence.configKey);
  const allowedGroups = markGroupIndicesForIssue(issue.jsonPointer, ctx.spec);

  if (section === 'text') {
    return {
      kind: 'text',
      boxes: locateTextMarksInGroups(ctx.scenegraphRoot, allowedGroups),
    };
  }

  // Renamed local to avoid shadowing the new `kind` field on ResolvedRegion.
  const elementKind = kindFromEvidence(section, evidence.role === 'title');
  if (!elementKind) return {kind: 'text', boxes: []};

  const channel =
    channelFromPointer(issue.jsonPointer) ??
    channelFromLabel(typeof evidence.element === 'string' ? evidence.element : '');

  return {
    kind: 'text',
    boxes: locateTextElement(elementKind, channel, ctx.scenegraphRoot, allowedGroups),
  };
};