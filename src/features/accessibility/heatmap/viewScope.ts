/**
 * viewScope.ts
 *
 * Bridge between an issue's JSON pointer and the scenegraph mark
 * groups it concerns.
 *
 * Why this exists: heatmap resolvers used to handle only `/layer/N/`
 * scoping. A vconcat / hconcat / concat issue at
 * `/vconcat/0/encoding/...` carried no `/layer/` prefix, so the
 * resolver fell back to "no filter" — painting every panel's marks
 * instead of just the one the issue belongs to.
 *
 * The trick: Vega-Lite emits mark groups into the scenegraph in DFS
 * order over the spec tree (layers in spec order, concat panels in
 * spec order). So if we walk the spec in the same DFS order and
 * count unit views as we go, the Nth unit we visit is the Nth mark
 * group in the scenegraph. That gives us a clean spec → scenegraph
 * mapping without depending on any Vega scenegraph naming
 * conventions.
 *
 * One pointer → one Set<number> of mark-group indices. The Set form
 * matters because a single composition prefix (e.g. `/vconcat/0`)
 * may correspond to multiple mark groups if the panel itself
 * contains layers.
 */

import type {BoundingBox, SceneItem}  from './boundingBox.js';

/** A single step in a composition path. */
export type ViewPathStep =
  | {type: 'layer'; index: number}
  | {type: 'vconcat'; index: number}
  | {type: 'hconcat'; index: number}
  | {type: 'concat'; index: number}
  | {type: 'spec'};

const INDEXED_COMPOSITIONS = new Set(['layer', 'vconcat', 'hconcat', 'concat']);

/** Stable string key for one step, used for prefix comparison. */
function stepKey(step: ViewPathStep): string {
  return step.type === 'spec' ? 'spec' : `${step.type}/${step.index}`;
}

/**
 * Pull the composition prefix off a JSON pointer.
 *
 *   `/vconcat/0/encoding/color/value` → [{type: 'vconcat', index: 0}]
 *   `/layer/2/mark`                   → [{type: 'layer', index: 2}]
 *   `/vconcat/0/layer/1/encoding/x`   → [{vconcat,0}, {layer,1}]
 *   `/encoding/color`                 → []  (top-level, no scope)
 *   `/config/text/fontSize`           → []  (config-source, no scope)
 *
 * Stops as soon as a non-composition segment is reached. Indexed
 * compositions (layer / vconcat / hconcat / concat) consume two
 * segments; `spec` consumes one.
 */
export function extractViewPath(pointer: string): ViewPathStep[] {
  if (!pointer) return [];
  const segments = pointer.split('/').filter(Boolean);
  const out: ViewPathStep[] = [];

  let i = 0;
  while (i < segments.length) {
    const seg = segments[i];

    if (INDEXED_COMPOSITIONS.has(seg)) {
      const next = segments[i + 1];
      const index = Number(next);
      // Defensive: a malformed pointer like `/vconcat/abc/...` falls
      // back to whatever path we've parsed so far rather than crashing.
      if (next === undefined || !Number.isFinite(index)) break;
      out.push({type: seg as 'layer' | 'vconcat' | 'hconcat' | 'concat', index});
      i += 2;
      continue;
    }

    if (seg === 'spec') {
      out.push({type: 'spec'});
      i += 1;
      continue;
    }

    // First non-composition segment — encoding / mark / config / …
    break;
  }

  return out;
}

/** True iff every step of `prefix` matches the start of `path`. */
function pathStartsWith(path: ViewPathStep[], prefix: ViewPathStep[]): boolean {
  if (prefix.length > path.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (stepKey(path[i]) !== stepKey(prefix[i])) return false;
  }
  return true;
}

/**
 * Walk the spec in DFS order and collect the indices of all
 * mark-bearing unit views whose composition path starts with `target`.
 *
 * DFS order matches Vega-Lite's scenegraph mark-group emission order,
 * so the Nth unit we encounter is the Nth `role: 'mark'` group in the
 * scenegraph. Index 0 is always the first mark group to appear,
 * regardless of how deeply nested it is.
 *
 * Every unit with a `mark` property counts, including text marks.
 * That matches `collectDataMarkBoxes`, which increments its
 * mark-group counter for every encountered group before deciding
 * whether to skip text ones — keeping spec-side and scenegraph-side
 * counters in lockstep.
 */
export function markGroupIndicesForViewPath(
  spec: Record<string, unknown>,
  target: ViewPathStep[],
): Set<number> {
  const out = new Set<number>();
  let counter = 0;

  const walk = (node: unknown, currentPath: ViewPathStep[]): void => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const obj = node as Record<string, unknown>;

    // Unit view: it owns exactly one mark group.
    if (obj.mark != null) {
      if (pathStartsWith(currentPath, target)) {
        out.add(counter);
      }
      counter++;
      return;
    }

    // Container: descend into its children with the path extended.
    if (Array.isArray(obj.layer)) {
      obj.layer.forEach((child, i) =>
        walk(child, [...currentPath, {type: 'layer', index: i}]),
      );
    }
    for (const key of ['vconcat', 'hconcat', 'concat'] as const) {
      const arr = obj[key];
      if (Array.isArray(arr)) {
        arr.forEach((child, i) =>
          walk(child, [...currentPath, {type: key, index: i}]),
        );
      }
    }
    if (obj.spec) {
      walk(obj.spec, [...currentPath, {type: 'spec'}]);
    }
  };

  walk(spec, []);
  return out;
}

/**
 * Convenience: turn an issue's pointer directly into the mark-group
 * filter to pass to scenegraph walkers.
 *
 * Returns `null` when the issue carries no composition scope
 * (pointer like `/encoding/color/value` or `/config/...`). `null`
 * means "every mark group", matching the no-filter semantics of the
 * downstream walkers and keeping top-level specs working untouched.
 */
export function markGroupIndicesForIssue(
  pointer: string,
  spec: Record<string, unknown>,
): Set<number> | null {
  const path = extractViewPath(pointer);
  if (path.length === 0) return null;
  return markGroupIndicesForViewPath(spec, path);
}

/**
 * Absolute bounds of every "real" data mark group in the scenegraph,
 * keyed by a stable index that ALSO matches what
 * `markGroupIndicesForViewPath` produces from the spec.
 *
 * Real means: bounds present and non-degenerate. Vega-Lite compiles
 * selection `params` (e.g. an interval brush) into their own scene
 * mark groups that occupy zero-by-zero rectangles. Counting those
 * would shift every subsequent index and break the spec→scenegraph
 * mapping — see the [a11y debug] output where /vconcat/1 should
 * resolve to mark group 3 (the bars) but the spec walker labels it 1
 * because the spec doesn't know about the synthetic selection marks.
 *
 * Skipping degenerate-bounds groups bypasses that without needing to
 * recognise selection marks specifically. The same skip is applied
 * symmetrically in `collectDataMarkBoxes` and `locateTextMarksInGroups`
 * so all three walkers agree on which mark group is "the Nth one".
 */
export function collectMarkGroupBounds(root: SceneItem): Map<number, BoundingBox> {
  const out = new Map<number, BoundingBox>();
  let groupIndex = 0;

  const visit = (item: SceneItem, offsetX: number, offsetY: number): void => {
    if (item.role === 'mark') {
      const b = item.bounds;
      const hasBounds = !!b && b.x2 > b.x1 && b.y2 > b.y1;
      if (hasBounds) {
        out.set(groupIndex, {
          x: b.x1 + offsetX,
          y: b.y1 + offsetY,
          width: b.x2 - b.x1,
          height: b.y2 - b.y1,
        });
        groupIndex++;
      }
      return; // Mark groups don't nest.
    }
    const childX = offsetX + (typeof item.x === 'number' ? item.x : 0);
    const childY = offsetY + (typeof item.y === 'number' ? item.y : 0);
    item.items?.forEach((child) => visit(child, childX, childY));
  };

  visit(root, 0, 0);
  return out;
}

/** Distance from a point to the closest point on an axis-aligned
 * rectangle. Zero when the point lies inside the rectangle. */
function distancePointToRect(px: number, py: number, rect: BoundingBox): number {
  const dx = Math.max(rect.x - px, 0, px - (rect.x + rect.width));
  const dy = Math.max(rect.y - py, 0, py - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

/**
 * Keep only boxes whose nearest mark group is in the allowed set.
 *
 * "Nearest" is measured as distance from the box's centre to the
 * closest edge of each mark-group rectangle (zero when inside). Axis
 * labels sit immediately outside their own panel's mark group, so
 * they score ~0 against that panel and a clearly larger positive
 * distance against every other panel — even when another panel
 * happens to be more vertically/horizontally central overall.
 *
 * Layered panels share a coord system, so their mark groups overlap;
 * a label inside that shared area returns 0 to each, and the filter
 * keeps it as long as ANY of those overlapping groups is allowed.
 *
 * Falls back to keeping everything if no mark groups have bounds, so
 * a scenegraph snapshot taken mid-render doesn't drop labels outright.
 */
export function clipBoxesToMarkGroups(
  boxes: BoundingBox[],
  allowedGroups: Set<number>,
  markBounds: Map<number, BoundingBox>,
): BoundingBox[] {
  if (markBounds.size === 0) return boxes;

  return boxes.filter((box) => {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    let nearestIndex = -1;
    let nearestDistance = Infinity;
    for (const [index, mb] of markBounds) {
      const d = distancePointToRect(cx, cy, mb);
      if (d < nearestDistance) {
        nearestDistance = d;
        nearestIndex = index;
      }
    }
    
    return nearestIndex !== -1 && allowedGroups.has(nearestIndex);
  });
}

/**
 * For each scene item, find the index of the mark group it shares
 * the deepest ancestry with — i.e. which panel of a concat
 * composition it sits inside structurally.
 *
 * Why structural rather than geometric: an x-axis title in a vconcat
 * sits below one panel's plot and above the next, so geometric
 * "nearest edge" can misattribute it. Its ANCESTRY, however,
 * unambiguously names the panel — the title shares
 * root → panel-0 → axis with panel 0's mark group, but only root
 * with panel 1's.
 *
 * Index matches `markGroupIndicesForViewPath` and
 * `collectMarkGroupBounds` — the Nth bounded `role: 'mark'` group in
 * DFS order. Items tied between marks at the deepest depth are left
 * UNMAPPED, which is the signature of a global element like the
 * chart title; a filter using this map can treat "not in map" as
 * "not panel-scoped" and let it through.
 */
export function computeStructuralMarkGroupMap(
  root: SceneItem,
): Map<SceneItem, number> {
  const out = new Map<SceneItem, number>();
  const marks: Array<{index: number; chain: SceneItem[]}> = [];
  let count = 0;

  const findMarks = (item: SceneItem, chain: SceneItem[]): void => {
    if (item.role === 'mark') {
      const b = item.bounds;
      const hasBounds = !!b && b.x2 > b.x1 && b.y2 > b.y1;
      if (hasBounds) {
        marks.push({index: count, chain: [...chain, item]});
        count++;
      }
      return;
    }
    item.items?.forEach((c) => findMarks(c, [...chain, item]));
  };
  findMarks(root, []);
  if (marks.length === 0) return out;

  const assign = (item: SceneItem, chain: SceneItem[]): void => {
    let bestIndex = -1;
    let bestDepth = 0;
    let tied = false;
    for (const {index, chain: mc} of marks) {
      let d = 0;
      while (d < chain.length && d < mc.length && chain[d] === mc[d]) d++;
      if (d > bestDepth) {
        bestDepth = d;
        bestIndex = index;
        tied = false;
      } else if (d === bestDepth && d > 0) {
        tied = true;
      }
    }
    if (bestIndex !== -1 && !tied) out.set(item, bestIndex);
    item.items?.forEach((c) => assign(c, [...chain, item]));
  };
  assign(root, []);

  return out;
}