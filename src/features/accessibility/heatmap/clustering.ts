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
import {unionBounds} from './boundingBox.js';
import type {IssueRegion} from './resolvers.js';

export type Severity = 'warning' | 'info';

export interface IssueCluster {
  /** Union of all member boxes — where the blob is drawn. */
  box: BoundingBox;
  /** The distinct issues represented here (deduped by key). */
  issues: AccessibilityIssue[];
  /** Their keys, for coordinating hover with the editor and pane. */
  keys: string[];
  /** Worst severity among members — drives the blob colour. */
  severity: Severity;
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
        members.some((m) => overlaps(m.box, region.box)),
      );
    if (group) {
      group.push(region);
    } else {
      groups.push([region]);
    }
  }

  return groups.map((members) => {
    const box = unionBounds(members.map((m) => m.box))!;

    // Dedupe by key: one issue can contribute several regions to the
    // same cluster (rare), and we want it counted once.
    const byKey = new Map<string, AccessibilityIssue>();
    for (const m of members) {
      byKey.set(m.key, m.issue);
    }

    const keys = [...byKey.keys()];
    const severity = (members[0].issue.severity === 'warning' ? 'warning' : 'info') as Severity;
    return {box, issues: [...byKey.values()], keys, severity, count: keys.length};
  });
}

/**
 * Warnings take visual precedence over suggestions. Where a warning
 * blob and a suggestion blob land on the same spot, drawing both
 * (transparent fills) muddies them into grey. So we hide any
 * suggestion cluster a warning cluster already covers: the user sees
 * the orange (warning) blob, and once the warning is fixed the
 * suggestion is no longer covered and its blue blob appears.
 *
 * Also returns clusters in paint order — suggestions first, warnings
 * last — so warnings render on top (SVG paints in document order).
 */
export function orderByPrecedence(clusters: IssueCluster[]): IssueCluster[] {
  const warnings = clusters.filter((c) => c.severity === 'warning');
  const suggestions = clusters.filter((c) => c.severity === 'info');

  const visibleSuggestions = suggestions.filter(
    (s) => !warnings.some((w) => overlaps(s.box, w.box)),
  );

  return [...visibleSuggestions, ...warnings];
}