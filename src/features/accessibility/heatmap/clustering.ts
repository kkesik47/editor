/**
 * clustering.ts
 *
 * Groups overlapping issue regions into clusters so the heatmap can
 * draw ONE blob per hotspot instead of stacking many rectangles on the
 * same spot.
 *
 * Why this exists: several rules legitimately point at the same place.
 * A red/green nominal scale, for instance, trips colour-risk AND
 * colourblind-safety, and both resolve to the same marks + legend
 * boxes. Drawn raw, those identical rectangles just pile up — you can't
 * tell "three issues here" from "one strong issue", and only the
 * topmost catches the mouse, so the ones beneath are unreachable.
 *
 * Clustering fixes both: overlapping regions merge into one cluster
 * that knows how many issues it represents (a count badge) and which
 * issues they are (so hovering can highlight every relevant source
 * line, not just one).
 *
 * The count also feeds the heatmap aesthetic: a cluster with more
 * issues is drawn more intensely — the literal "hot spot" reading.
 */

import type {AccessibilityIssue} from '../types.js';
import type {BoundingBox} from './boundingBox.js';
import {unionBounds, inflateBox} from './boundingBox.js';
import type {IssueRegion, RegionKind} from './resolvers.js';

/**
 * Scene-space padding applied to MARK regions before the overlap
 * test during clustering. Adjacent marks (neighbouring scatter
 * points, sibling bars) then merge into one cluster instead of each
 * becoming its own tiny blob with its own badge. Text regions don't
 * inflate — labels and titles must stay distinct or the badge sits
 * between them and the chart reads as "everything is one issue".
 */
const MARK_CLUSTER_PADDING = 10;

export type Severity = 'warning' | 'info';

export interface IssueCluster {
  /** Union of all member boxes — used to place the badge. */
  box: BoundingBox;
  /**
   * Individual member boxes after deduplication. One blob is drawn
   * per box, so dense scatters render as a string of overlapping
   * halos and bar rows render as one blob per bar, while the cluster
   * still carries a single badge sitting at `box`'s top-right.
   */
  memberBoxes: BoundingBox[];
  /** The distinct issues represented here (deduped by key). */
  issues: AccessibilityIssue[];
  /** Their keys, for coordinating hover with the editor and pane. */
  keys: string[];
  /** Worst severity among members — drives the blob colour. */
  severity: Severity;
  /**
   * Whether this cluster paints marks or text. Drives inflation
   * during clustering (marks inflate, text doesn't) and paint order
   * during rendering (text paints on top of marks).
   */
  kind: RegionKind;
  /** How many distinct issues — drives blob intensity and the badge. */
  count: number;
}

/** Two boxes "overlap" when their intersection covers a meaningful
 *  fraction of the smaller one. A mere shared edge (fraction ~0) does
 *  not count, so adjacent-but-distinct elements (an axis label row and
 *  the axis title just below it) stay separate, while identical boxes
 *  (the colour rules on the marks) always merge. */
function overlaps(a: BoundingBox, b: BoundingBox, minFraction = 0.15): boolean {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = ix * iy;
  if (intersection === 0) return false;

  const smallerArea = Math.min(a.width * a.height, b.width * b.height);
  return smallerArea > 0 && intersection / smallerArea >= minFraction;
}

/** Pick the more serious of two severities (warning beats info). */
function worse(a: Severity, b: Severity): Severity {
  return a === 'warning' || b === 'warning' ? 'warning' : 'info';
}

/** Inflate mark regions before the overlap test so adjacent marks
 *  merge; leave text regions untouched. */
function clusterBoxOf(region: IssueRegion): BoundingBox {
  return region.kind === 'mark'
    ? inflateBox(region.box, MARK_CLUSTER_PADDING)
    : region.box;
}

/**
 * Pointer-shape priority for what a cluster click should jump to.
 *
 * When several contrast issues land in one cluster — typically a
 * `condition.value` lightgray fallback alongside failing
 * `condition.scale.range` colours on the same marks — we want
 * `keys[0]` to be the issue that matches the marks' currently
 * rendered colours. The value fallback only manifests under
 * interaction (a selection actively excluding items); the scale
 * range is what the marks actually paint with by default. So
 * scale-related pointers rank above bare `/value` pointers.
 *
 * Lower number = higher priority (sorts first).
 */
function pointerPriority(pointer: string): number {
  if (pointer.includes('/scale/') || pointer.includes('/range')) return 1;
  if (pointer.endsWith('/value')) return 3;
  return 2;
}

/**
 * Greedy single-pass clustering. Each region joins the first existing
 * cluster it overlaps with (against ANY member, so chains A–B–C merge
 * correctly); otherwise it starts a new one. Region counts are tiny
 * (a handful per chart), so the simple O(n²) approach is plenty and
 * stays readable.
 */
export function clusterRegions(regions: IssueRegion[]): IssueCluster[] {
  const groups: IssueRegion[][] = [];

  for (const region of regions) {
    const group = groups.find(
      (members) =>
        members[0].issue.severity === region.issue.severity &&
        members[0].kind === region.kind &&
        members.some((m) => overlaps(clusterBoxOf(m), clusterBoxOf(region))),
    );
    if (group) {
      group.push(region);
    } else {
      groups.push([region]);
    }
  }

  return groups.map((members) => {
    const sorted = [...members].sort(
      (a, b) => pointerPriority(a.issue.jsonPointer) - pointerPriority(b.issue.jsonPointer),
    );

    const box = unionBounds(sorted.map((m) => m.box))!;

    // Dedup member boxes by rounded coordinates. Two rules firing on
    // the same scale (e.g. colourblind-safety + colour-only) produce
    // identical mark boxes; rendering two ellipses on the exact same
    // coordinates doubles the apparent fill opacity.
    const seenBox = new Set<string>();
    const memberBoxes: BoundingBox[] = [];
    for (const m of sorted) {
      const k = `${Math.round(m.box.x)},${Math.round(m.box.y)},${Math.round(m.box.width)},${Math.round(m.box.height)}`;
      if (seenBox.has(k)) continue;
      seenBox.add(k);
      memberBoxes.push(m.box);
    }

    const byKey = new Map<string, AccessibilityIssue>();
    for (const m of sorted) byKey.set(m.key, m.issue);

    const keys = [...byKey.keys()];
    const severity = (sorted[0].issue.severity === 'warning' ? 'warning' : 'info') as Severity;
    const kind = sorted[0].kind;

    return {box, memberBoxes, issues: [...byKey.values()], keys, severity, kind, count: keys.length};
  });
}

/**
 * Warnings take visual precedence over suggestions OF THE SAME KIND.
 * Where a mark-warning and a mark-suggestion land on the same spot,
 * drawing both muddies them into grey — so the mark-suggestion is
 * hidden. A text-suggestion on a label paints something different
 * from the mark blob underneath and shouldn't be hidden by it, so
 * we restrict the suppression to same-kind warnings.
 *
 * Returns clusters in paint order: marks first, then text on top.
 * Within each kind, suggestions paint before warnings so warnings
 * stay visible; text on top keeps tight label/title blobs from
 * being washed out by mark-warning halos bleeding into them.
 */
export function orderByPrecedence(clusters: IssueCluster[]): IssueCluster[] {
  const warnings = clusters.filter((c) => c.severity === 'warning');
  const suggestions = clusters.filter((c) => c.severity === 'info');

  const visibleSuggestions = suggestions.filter(
    (s) => !warnings.some((w) => w.kind === s.kind && overlaps(s.box, w.box)),
  );

  const all = [...visibleSuggestions, ...warnings];
  return [
    ...all.filter((c) => c.kind === 'mark'),
    ...all.filter((c) => c.kind === 'text'),
  ];
}