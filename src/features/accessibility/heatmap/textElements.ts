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
function collectAxisLabelLeaves(root: SceneItem, channel: Channel): BoundingBox[] {
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
        item.bounds.x2 - item.bounds.x1 >= item.bounds.y2 - item.bounds.y1
          ? 'x'
          : 'y';
      if (groupChannel === channel) {
        const childX = offsetX + (typeof item.x === 'number' ? item.x : 0);
        const childY = offsetY + (typeof item.y === 'number' ? item.y : 0);
        item.items?.forEach((child) => recordLeaves(child, childX, childY));
      }
      // Axis-label groups don't nest; stop here either way.
      return;
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
export function locateTextElement(kind: TextElementKind, channel: Channel | null, root: SceneItem): BoundingBox[] {
  switch (kind) {
    case 'chart-title':
      return collectAbsoluteBoxes(root, (item) => item.role === 'title');

    case 'legend-label':
      return collectAbsoluteBoxes(root, (item) => item.role === 'legend-label');

    case 'legend-title':
      return collectAbsoluteBoxes(root, (item) => item.role === 'legend-title');

    case 'axis-label': {
      if (channel) return collectAxisLabelLeaves(root, channel);
      return [
        ...collectAxisLabelLeaves(root, 'x'),
        ...collectAxisLabelLeaves(root, 'y'),
      ];
    }

    case 'axis-title': {
      // Titles stay as one box per axis — a single rotated word has no
      // sub-elements worth clustering.
      const axes = identifyAxes(root);
      if (channel) {
        const box = axes[channel].title;
        return box ? [box] : [];
      }
      return [axes.x.title, axes.y.title].filter(
        (box): box is BoundingBox => box !== null,
      );
    }
    }
  }

  // ─── Text-mark placement (layer-scoped) ──────────────────────────

/**
 * Locate the text glyphs belonging to one `mark: text` layer.
 *
 * Text marks scope by LAYER (not by channel like axes do), so they
 * sit outside locateTextElement's (kind, channel) shape and get their
 * own function instead.
 *
 * Layer identification: Vega-Lite renders layers in spec order, one
 * `role: 'mark'` group per layer, so the Nth `role: 'mark'` group
 * encountered in DFS order corresponds to spec layer N. The group's
 * marktype must be 'text' for the issue to apply; if not, we return
 * empty (the pointer named a non-text-mark layer somehow — should not
 * happen in practice, but defensive).
 *
 * Pass `layerIndex = null` to cover EVERY text-mark glyph on the
 * chart. That's the right scope for config-source issues, whose
 * pointer is /config/text/fontSize and applies to all text marks at
 * once.
 *
 * Returns per-glyph boxes (no union) so the heatmap clusters them
 * into focused blobs over each label, mirroring colorScaleResolver's
 * use of collectDataMarkBoxes.
 *
 * Limitation: only top-level /layer/N/mark pointers are handled; a
 * nested-layer pointer like /layer/0/layer/2/mark would resolve the
 * wrong group. Adequate for the specs we've seen.
 */
export function locateTextMarkForLayer(
  root: SceneItem,
  layerIndex: number | null,
): BoundingBox[] {
  const out: BoundingBox[] = [];
  let markGroupCount = 0;

  const visit = (
    item: SceneItem,
    offsetX: number,
    offsetY: number,
    insideTargetGroup: boolean,
  ): void => {
    let nextInside = insideTargetGroup;

    if (item.role === 'mark') {
      const isText = item.marktype === 'text';
      const isTargetLayer =
        layerIndex === null || markGroupCount === layerIndex;
      markGroupCount++;

      // Skip the entire mark group if it isn't the layer we want, or
      // if it isn't a text mark at all. Mark groups don't nest, so
      // skipping descent here is safe.
      if (!isText || !isTargetLayer) return;
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