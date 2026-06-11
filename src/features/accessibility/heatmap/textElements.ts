/**
 * textElements.ts
 *
 * Shared logic for locating TEXT elements on the rendered chart.
 *
 * Two rules point at the same set of text elements — fontSizeRule
 * (text too small) and contrastRule's text branch (text too low
 * contrast). Both need to answer "where is the chart title / these
 * axis labels / that legend title on the chart?". That placement logic
 * lives here so both resolvers share it; each resolver only has to
 * translate its own evidence into a (kind, channel) pair.
 *
 * The five kinds map directly onto Vega scenegraph roles:
 *   chart-title  → role 'title'
 *   axis-label   → role 'axis-label'   (narrowed to one axis)
 *   axis-title   → role 'axis-title'   (narrowed to one axis)
 *   legend-label → role 'legend-label'
 *   legend-title → role 'legend-title'
 */

import type {BoundingBox, SceneItem} from './boundingBox.js';
import {collectAbsoluteBoxes} from './boundingBox.js';
import {computeStructuralMarkGroupMap} from './viewScope.js';

export type TextElementKind = 'chart-title' | 'axis-label' | 'axis-title' | 'legend-label' | 'legend-title';

export type Channel = 'x' | 'y';

// ─── Channel detection ───────────────────────────────────────────

/**
 * Which axis channel does this pointer name? Encoding pointers name a
 * channel; config pointers don't (they apply to every axis), so we
 * return null and the caller highlights all axes. xOffset/yOffset fold
 * into x/y since they share the same visual orientation.
 */
export function channelFromPointer(pointer: string): Channel | null {
  const match = /^\/encoding\/(x|y|xOffset|yOffset)(\/|$)/.exec(pointer ?? '');
  if (!match) return null;
  return match[1][0] === 'x' ? 'x' : 'y';
}

/**
 * Fallback channel detection from an element label like "X-axis labels"
 * or "Y-axis title". Used when the pointer is a config path (no channel
 * in it) but the issue's label still says which axis it is.
 */
export function channelFromLabel(label: string): Channel | null {
  const match = /^([xy])[\s-]/i.exec((label ?? '').trim());
  if (!match) return null;
  return match[1].toLowerCase() === 'x' ? 'x' : 'y';
}

// ─── Axis identification ─────────────────────────────────────────

/** The label and title regions belonging to one axis. */
interface AxisRegion {
  labels: BoundingBox | null;
  title: BoundingBox | null;
}

/** Centre of a box. */
function centre(box: BoundingBox): {x: number; y: number} {
  return {x: box.x + box.width / 2, y: box.y + box.height / 2};
}

/**
 * Channel whose labels are closest to the given (title) box. Falls back
 * to the box's own aspect ratio if a side has no labels to compare to.
 */
function nearestAxisChannel(box: BoundingBox, axes: Record<Channel, AxisRegion>): Channel {
  const c = centre(box);
  const distanceTo = (region: AxisRegion): number => {
    if (!region.labels) return Infinity;
    const l = centre(region.labels);
    return Math.hypot(c.x - l.x, c.y - l.y);
  };

  const dx = distanceTo(axes.x);
  const dy = distanceTo(axes.y);
  if (dx === Infinity && dy === Infinity) return box.width >= box.height ? 'x' : 'y';
  return dx <= dy ? 'x' : 'y';
}

/**
 * Identify the x and y axes from the scenegraph and return each one's
 * label and title boxes.
 *
 * Telling the axes apart without relying on undocumented orientation
 * fields: a row of x-axis tick labels spreads HORIZONTALLY (its union
 * box is wider than tall), while a column of y-axis labels spreads
 * VERTICALLY (taller than wide). That directly reflects which spatial
 * dimension the axis measures, i.e. its encoding channel.
 *
 * Axis titles are single rotated words, so their own aspect ratio is
 * unreliable; each title is instead attached to whichever axis's labels
 * sit closest to it.
 *
 * Limitation (acceptable for now): assumes one x and one y axis. Offset
 * axes or a second axis on the opposite side would need richer logic.
 */
function identifyAxes(root: SceneItem): Record<Channel, AxisRegion> {
  const axes: Record<Channel, AxisRegion> = {
    x: {labels: null, title: null},
    y: {labels: null, title: null},
  };

  // Each axis-label MARK carries the union box of its tick labels, so
  // there is one box per axis already.
  for (const box of collectAbsoluteBoxes(root, (item) => item.role === 'axis-label')) {
    const channel: Channel = box.width >= box.height ? 'x' : 'y';
    axes[channel].labels = box;
  }

  for (const box of collectAbsoluteBoxes(root, (item) => item.role === 'axis-title')) {
    axes[nearestAxisChannel(box, axes)].title = box;
  }

  return axes;
}

/**
 * Collect per-glyph boxes for one axis's tick labels.
 *
 * Each `role: 'axis-label'` item is the GROUP that contains all of one
 * axis's tick-label glyphs, with bounds covering the whole row/column.
 * Using those bounds gives a single elongated blob spanning every
 * label; walking into the group and recording each leaf gives the
 * heatmap something to cluster into focused per-label blobs.
 *
 * Channel identification mirrors identifyAxes: a horizontal spread is
 * x, a vertical column is y.
 */
function collectAxisLabelLeaves(root: SceneItem,
  channel: Channel,
  inScope: (item: SceneItem) => boolean = () => true,
  ): BoundingBox[] {
  const out: BoundingBox[] = [];

  const recordLeaves = (
    item: SceneItem,
    offsetX: number,
    offsetY: number,
  ): void => {
    const isLeaf = !item.items || item.items.length === 0;
    if (item.bounds && isLeaf) {
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
    item.items?.forEach((child) => recordLeaves(child, childX, childY));
  };

  const visit = (item: SceneItem, offsetX: number, offsetY: number): void => {
    if (item.role === 'axis-label' && item.bounds) {
      const groupChannel: Channel =
        item.bounds.x2 - item.bounds.x1 >= item.bounds.y2 - item.bounds.y1 ? 'x' : 'y';
      if (groupChannel === channel && inScope(item)) {
        const childX = offsetX + (typeof item.x === 'number' ? item.x : 0);
        const childY = offsetY + (typeof item.y === 'number' ? item.y : 0);
        item.items?.forEach((child) => recordLeaves(child, childX, childY));
      }
      return;
    }
    const childX = offsetX + (typeof item.x === 'number' ? item.x : 0);
    const childY = offsetY + (typeof item.y === 'number' ? item.y : 0);
    item.items?.forEach((child) => visit(child, childX, childY));
  };

  visit(root, 0, 0);
  return out;
}

/**
 * Locate axis-title boxes directly from `role: 'axis-title'` scene
 * items, with optional structural scoping.
 *
 * Replaces the `identifyAxes`-based path for titles, which kept only
 * one title per channel and so dropped the second x/y axis title in
 * a vconcat. Walking directly for axis-title items returns ALL of
 * them; the `inScope` predicate then filters by structural panel.
 *
 * Channel is read from the title's own rendered aspect ratio: x-axis
 * titles are horizontal text and read as wider-than-tall; y-axis
 * titles are rotated 90° and read as taller-than-wide.
 */
function collectAxisTitles(
  root: SceneItem,
  channel: Channel | null,
  inScope: (item: SceneItem) => boolean = () => true,
): BoundingBox[] {
  const out: BoundingBox[] = [];

  const visit = (item: SceneItem, offsetX: number, offsetY: number): void => {
    if (item.role === 'axis-title' && item.bounds && inScope(item)) {
      const b = item.bounds;
      const box: BoundingBox = {
        x: b.x1 + offsetX,
        y: b.y1 + offsetY,
        width: b.x2 - b.x1,
        height: b.y2 - b.y1,
      };
      const titleChannel: Channel = box.width >= box.height ? 'x' : 'y';
      if (channel === null || titleChannel === channel) {
        out.push(box);
      }
    }
    const childX = offsetX + (typeof item.x === 'number' ? item.x : 0);
    const childY = offsetY + (typeof item.y === 'number' ? item.y : 0);
    item.items?.forEach((child) => visit(child, childX, childY));
  };

  visit(root, 0, 0);
  return out;
}

// ─── Placement ───────────────────────────────────────────────────

/**
 * Locate a text element on the chart. For axis elements, `channel`
 * narrows to one axis; pass null to highlight all axes (e.g. a
 * config-level issue that applies to every axis).
 */
export function locateTextElement(
  kind: TextElementKind,
  channel: Channel | null,
  root: SceneItem,
  allowedGroups: Set<number> | null = null,
): BoundingBox[] {
  // Structural map is only worth computing when there's something to
  // filter against. Without allowedGroups, every item is in scope.
  const groupMap = allowedGroups ? computeStructuralMarkGroupMap(root) : null;
  const inScope = (item: SceneItem): boolean => {
    if (!groupMap || !allowedGroups) return true;
    const g = groupMap.get(item);
    // Items unmapped by the structural map are root-level globals
    // (chart title etc.) — let them through; the resolver's choice of
    // allowedGroups already restricts what's emitted at the spec side.
    return g == null || allowedGroups.has(g);
  };

  switch (kind) {
    case 'chart-title':
      return collectAbsoluteBoxes(root, (i) => i.role === 'title' && inScope(i));

    case 'legend-label':
      return collectAbsoluteBoxes(root, (i) => i.role === 'legend-label' && inScope(i));

    case 'legend-title':
      return collectAbsoluteBoxes(root, (i) => i.role === 'legend-title' && inScope(i));

    case 'axis-label':
      if (channel) return collectAxisLabelLeaves(root, channel, inScope);
      return [
        ...collectAxisLabelLeaves(root, 'x', inScope),
        ...collectAxisLabelLeaves(root, 'y', inScope),
      ];

    case 'axis-title':
      return collectAxisTitles(root, channel, inScope);
  }
}

  // ─── Text-mark placement ──────────────────────────

/**
 * Locate the text glyphs belonging to one or more `mark: text` groups.
 *
 * Text marks scope by mark-group index — Vega-Lite renders text-mark
 * units in spec DFS order, so the Nth `role: 'mark'` group with
 * marktype 'text' is the unit at that DFS position. Pass the Set of
 * allowed indices to restrict to specific units, or `null` to cover
 * every text mark on the chart (the right scope for a config-source
 * issue at /config/text/fontSize, which applies globally).
 *
 * Returns per-glyph boxes (no union) so the heatmap clusters them
 * into focused blobs over each label, mirroring colorScaleResolver's
 * use of collectDataMarkBoxes.
 *
 * Use `markGroupIndicesForIssue` from `viewScope.ts` to derive the
 * Set from an issue's pointer.
 */
export function locateTextMarksInGroups(
  root: SceneItem,
  allowedGroups: Set<number> | null,
): BoundingBox[] {
  const out: BoundingBox[] = [];
  let groupIndex = 0;

  const visit = (
    item: SceneItem,
    offsetX: number,
    offsetY: number,
    insideTargetGroup: boolean,
  ): void => {
    let nextInside = insideTargetGroup;

    if (item.role === 'mark') {
      const isText = item.marktype === 'text';
      const isTargetGroup =
        allowedGroups === null || allowedGroups.has(groupIndex);
      groupIndex++;

      // Skip the entire mark group if it isn't in scope or isn't a
      // text mark. Mark groups don't nest, so skipping descent is safe.
      if (!isText || !isTargetGroup) return;
      nextInside = true;
    }

    const isLeaf = !item.items || item.items.length === 0;
    if (insideTargetGroup && item.bounds && isLeaf) {
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