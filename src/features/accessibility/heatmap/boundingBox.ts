/**
 * boundingBox.ts
 *
 * Pure geometry helpers for the accessibility heatmap overlay.
 *
 * The overlay's job is: given an accessibility issue, paint a region
 * over the part of the rendered chart it concerns. To do that we walk
 * Vega's runtime scenegraph (a tree of "scene items", each with pixel
 * `bounds` and a semantic `role`), pick the items an issue refers to,
 * and merge their boxes into one rectangle to draw.
 *
 * THE COORDINATE GOTCHA (learned the hard way):
 *
 *   A scene item's `bounds` are NOT absolute. They are relative to the
 *   coordinate origin of the group that contains it. Groups carry an
 *   (x, y) translate - e.g. the x-axis group is pushed down by the plot
 *   height, the title group is pushed up. So an x-axis label may report
 *   bounds at y=7 while actually sitting at y=307 because its group is
 *   translated down by 300.
 *
 *   To get the true (absolute) position of any item, you add up the
 *   (x, y) of every ANCESTOR group on the way down to it. An item's own
 *   (x, y) is already baked into its own bounds, so it is only ever
 *   added to its CHILDREN, never to itself. collectAbsoluteBoxes does
 *   exactly this accumulation; resolvers should always go through it
 *   rather than reading `bounds` directly.
 */

/** An axis-aligned rectangle in the rendered chart's pixel space. */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A Vega scene item. We only type the handful of fields the overlay
 * reads; the real runtime object carries far more.
 *
 * - `bounds` is relative to the containing group's origin (see above).
 * - `x`/`y` is this item's own translate; it shifts this item's
 *   CHILDREN, and is already reflected in this item's own `bounds`.
 * - group items have `items` (child marks); leaf items do not.
 */
export interface SceneItem {
  marktype?: string;
  role?: string;
  x?: number;
  y?: number;
  bounds?: {x1: number; y1: number; x2: number; y2: number};
  items?: SceneItem[];
  datum?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Return a box expanded by `padding` scene units on every side.
 *
 * Used by clustering to merge nearby-but-not-overlapping mark boxes
 * into one cluster - so a dense scatterplot reads as one blob per
 * region rather than as one blob per dot. The original boxes are
 * still what unionBounds operates on, so the drawn blobs sit on the
 * actual marks; inflation only affects the overlap test.
 */
export function inflateBox(box: BoundingBox, padding: number): BoundingBox {
  return {
    x: box.x - padding,
    y: box.y - padding,
    width: box.width + 2 * padding,
    height: box.height + 2 * padding,
  };
}

/** Convert one scene item's (already-absolute) bounds into a BoundingBox. */
export function boundsFromSceneItem(item: SceneItem): BoundingBox | null {
  const b = item.bounds;
  if (!b) return null;
  return {x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1};
}

/**
 * Merge several boxes into the smallest box that contains them all.
 * Returns null for an empty list, so callers can simply skip drawing.
 */
export function unionBounds(boxes: BoundingBox[]): BoundingBox | null {
  if (boxes.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }

  return {x: minX, y: minY, width: maxX - minX, height: maxY - minY};
}

/**
 * Walk the scenegraph and return the ABSOLUTE bounding box of every
 * item the predicate accepts, accumulating ancestor group translates
 * so the boxes land where Vega actually drew them.
 *
 * This is the primitive every resolver builds on: accept items by
 * `role` (e.g. 'axis-label') or `marktype`, get their true boxes back,
 * then unionBounds them into one region.
 */
export function collectAbsoluteBoxes(root: SceneItem, accept: (item: SceneItem) => boolean): BoundingBox[] {
  const out: BoundingBox[] = [];

  const visit = (item: SceneItem, offsetX: number, offsetY: number) => {
    if (item.bounds && accept(item)) {
      const b = item.bounds;
      out.push({x: b.x1 + offsetX, y: b.y1 + offsetY, width: b.x2 - b.x1, height: b.y2 - b.y1});
    }
    // Children are positioned relative to THIS item's translate, so fold
    // it into the offset before recursing. A leaf has no children, so its
    // own x/y is never double-counted (it is already inside its bounds).
    const childX = offsetX + (typeof item.x === 'number' ? item.x : 0);
    const childY = offsetY + (typeof item.y === 'number' ? item.y : 0);
    item.items?.forEach((child) => visit(child, childX, childY));
  };

  visit(root, 0, 0);
  return out;
}

/**
 * Walk the scenegraph and return the absolute bounding box of each
 * individual data mark - the symbols, rects, lines etc. that Vega
 * draws to represent the data.
 *
 * Why this needs a separate walker from collectAbsoluteBoxes: a
 * `role: 'mark'` scene item is the GROUP that wraps the data marks,
 * and its bounds span the whole plot area. Using those bounds gives
 * an overlay that always covers the entire plot - for three sparse
 * scatter points, the bounding rectangle is the whole chart. We want
 * one box per actual mark, so blobs sit on the marks themselves and
 * clustering merges nearby ones.
 *
 * The walker switches into "inside mark group" mode at every
 * `role: 'mark'` item and stays in it for all descendants. Inside
 * that mode it records any leaf (non-group) scene item with bounds.

 * Marktypes that render as ONE coherent visual per series rather than
 * per data point. Going one level deeper into these doesn't help:
 * line/area paths span the plot extent of their data, and arc wedges
 * don't cluster cleanly with their neighbours. */
const SPREAD_MARKTYPES = new Set(['line', 'area', 'trail', 'arc']);

/** Marktypes that render glyphs - they belong to the TEXT branch of
 * the heatmap (text contrast / font size), never to non-text contrast
 * or any colour-scale rule. Skipping them here keeps colour-scale
 * resolvers from painting orange over chart labels like axis-value
 * text marks. */
const TEXT_MARKTYPES = new Set(['text']);

/**
 * Walk the scenegraph and return the absolute bounding box of each
 * individual data mark - the symbols, rects, lines etc. that Vega
 * draws to represent the data.
 *
 * Pass `allowedGroups` to restrict collection to specific mark
 * groups, indexed in DFS order (so the Nth `role: 'mark'` group
 * encountered is index N). Layers map 1-to-1 to mark groups, so a
 * layer-only scope is a one-element Set. `vconcat` / `hconcat` /
 * `concat` panels with several layers contribute several indices.
 * Pass `null` (the default) to collect every mark group - that
 * matches the top-level / single-unit case and rules whose scope is
 * global.
 *
 * Use `markGroupIndicesForIssue` from `viewScope.ts` to derive the
 * Set from an issue's pointer.
 */
export function collectDataMarkBoxes(root: SceneItem, allowedGroups: Set<number> | null = null): BoundingBox[] {
  const out: BoundingBox[] = [];
  let groupIndex = 0;

  const visit = (item: SceneItem, offsetX: number, offsetY: number, insideMarkGroup: boolean) => {
    if (item.role === 'mark') {
      const b = item.bounds;
      const hasBounds = !!b && b.x2 > b.x1 && b.y2 > b.y1;

      // Skip mark groups with no real bounds (synthetic groups Vega
      // emits for selection params). They contain no data marks anyway,
      // and counting them would shift the index for the real ones.
      if (!hasBounds) return;

      const thisGroup = groupIndex;
      groupIndex++;

      if (item.marktype && TEXT_MARKTYPES.has(item.marktype)) {
        return;
      }

      if (allowedGroups !== null && !allowedGroups.has(thisGroup)) {
        return;
      }

      if (item.marktype && SPREAD_MARKTYPES.has(item.marktype) && item.bounds) {
        out.push({x: b.x1 + offsetX, y: b.y1 + offsetY, width: b.x2 - b.x1, height: b.y2 - b.y1});
        return;
      }
    }

    // Discrete marktypes: record each leaf scene item inside the mark group.
    const isLeaf = !item.items || item.items.length === 0;
    if (insideMarkGroup && item.bounds && isLeaf) {
      const b = item.bounds;
      out.push({x: b.x1 + offsetX, y: b.y1 + offsetY, width: b.x2 - b.x1, height: b.y2 - b.y1});
    }

    const childX = offsetX + (typeof item.x === 'number' ? item.x : 0);
    const childY = offsetY + (typeof item.y === 'number' ? item.y : 0);
    const childInsideMarkGroup = insideMarkGroup || item.role === 'mark';

    item.items?.forEach((child) => visit(child, childX, childY, childInsideMarkGroup));
  };

  visit(root, 0, 0, false);
  return out;
}
