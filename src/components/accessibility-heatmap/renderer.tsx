/**
 * AccessibilityHeatmap (overlay) - heatmap blobs + clustered issues
 *
 * A transparent layer over the rendered chart that paints a soft,
 * heatmap-style blob wherever an accessibility issue manifests. Issues
 * that land on the same spot are merged into one cluster, drawn as a
 * single blob whose intensity grows with how many issues it represents
 * and tagged with a count badge - the literal "hot spot" reading.
 *
 * Two coordinate spaces are in play, and each visual lives in the one
 * that suits it:
 *
 *   • Blobs live in an <svg> whose viewBox is Vega's SCENE coordinate
 *     space (with preserveAspectRatio="none"). The browser maps those
 *     coordinates onto the displayed chart exactly the way Vega does,
 *     so resolver boxes drop in with no per-box maths. The non-uniform
 *     scaling stretches blobs a little, which only makes them look more
 *     organic - fine for soft shapes.
 *
 *   • Count badges live as HTML elements positioned in PIXEL space over
 *     the same container. A circle + number drawn inside the stretched
 *     SVG would be visibly squashed; in pixel space they stay crisp. A
 *     tiny scene→pixel projection (sceneToPixel) places them.
 *
 * The overlay is renderer-agnostic (reads view.scenegraph(), not the
 * DOM) and a pure consumer of issues - it never produces them, so the
 * settings toggle can hide it without touching evaluation.
 */

import * as React from 'react';
import {useLayoutEffect, useRef, useState} from 'react';
import {useAppContext} from '../../context/app-context.js';
import type {BoundingBox, SceneItem} from '../../features/accessibility/heatmap/boundingBox.js';
import {resolveIssueRegions, type IssueRegion} from '../../features/accessibility/heatmap/resolvers.js';
import {clusterRegions, orderByPrecedence} from '../../features/accessibility/heatmap/clustering.js';
import './index.css';
import {NAVBAR} from '../../constants/consts.js';

interface OverlayGeometry {
  /** Displayed position/size of the graphic, relative to the .chart box. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Vega scene-coordinate extent the displayed graphic maps to. */
  sceneMinX: number;
  sceneMinY: number;
  sceneWidth: number;
  sceneHeight: number;
}

/**
 * Above this many member boxes, drawing one ellipse per member would
 * stack into fully-opaque orange at the centre (SVG alpha composites
 * as 1 − (1 − a)^N, which saturates to 1 fast). Switch to a single
 * soft blob over the cluster's union box instead. Tuned to keep
 * disaster-style rows (~30–80 members) in per-member mode for the
 * "follow the data shape" look, while catching very dense scatters
 * before they go opaque.
 */
const LARGE_CLUSTER_THRESHOLD = 100;

/**
 * Pick the cluster member with the greatest area. The badge anchors
 * to this box's top-right corner so it sits ON a visible mark rather
 * than at the union's top-right, which for sparse rows often lands
 * in empty space above the rightmost dot.
 */
function largestMemberBox(boxes: BoundingBox[]): BoundingBox {
  let best = boxes[0];
  let bestArea = best.width * best.height;
  for (let i = 1; i < boxes.length; i++) {
    const a = boxes[i].width * boxes[i].height;
    if (a > bestArea) {
      best = boxes[i];
      bestArea = a;
    }
  }
  return best;
}

/** Find the actual <svg>/<canvas> Vega drew inside its container. */
function findGraphicElement(view: any): HTMLElement | null {
  const container: HTMLElement | null = view?.container?.() ?? null;
  if (!container) return null;
  return container.querySelector('svg, canvas');
}

/** Vega padding can be a single number or a per-side object. Normalise it. */
function readPadding(view: any): {left: number; right: number; top: number; bottom: number} {
  const p = view?.padding?.() ?? 0;
  if (typeof p === 'number') {
    return {left: p, right: p, top: p, bottom: p};
  }
  return {left: p.left ?? 0, right: p.right ?? 0, top: p.top ?? 0, bottom: p.bottom ?? 0};
}

/**
 * Measure where the rendered graphic sits (relative to its .chart
 * offset parent) and the Vega scene extent it maps to. Returns null
 * when the graphic or its bounds aren't available yet.
 */
function measureGeometry(view: any): OverlayGeometry | null {
  const graphic = findGraphicElement(view);
  if (!graphic) return null;

  const offsetParent = graphic.closest('.chart') as HTMLElement | null;
  if (!offsetParent) return null;

  const root: SceneItem | undefined = view.scenegraph?.()?.root;
  const b = root?.bounds;
  if (!b) return null;

  const g = graphic.getBoundingClientRect();
  const p = offsetParent.getBoundingClientRect();
  const pad = readPadding(view);

  return {
    left: g.left - p.left,
    top: g.top - p.top,
    width: g.width,
    height: g.height,
    sceneMinX: b.x1 - pad.left,
    sceneMinY: b.y1 - pad.top,
    sceneWidth: b.x2 - b.x1 + pad.left + pad.right,
    sceneHeight: b.y2 - b.y1 + pad.top + pad.bottom,
  };
}

/** Ask the resolvers to place the current issues on the chart. */
function computeRegions(view: any, issues: any[], spec: Record<string, unknown>): IssueRegion[] {
  const root: SceneItem | undefined = view?.scenegraph?.()?.root;
  if (!root || !issues?.length) return [];
  return resolveIssueRegions(issues, {scenegraphRoot: root, spec});
}

export default function AccessibilityHeatmap() {
  const {state, setState} = useAppContext();
  const view = state.view;
  const issues = state.accessibilityIssues ?? [];
  const spec = (state.vegaLiteSpec ?? {}) as Record<string, unknown>;
  // The settings toggle. Treat missing as ON so the overlay still works
  // before the toggle's state field is added, and is discoverable by
  // default once it is.
  const heatmapEnable = state.heatmapEnable !== false;

  const [geometry, setGeometry] = useState<OverlayGeometry | null>(null);
  const [regions, setRegions] = useState<IssueRegion[]>([]);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Re-runs whenever the view, the issues, or the spec change. The
  // closure therefore always captures the current issues/spec, so the
  // resize/raf callbacks below recompute regions correctly too.
  useLayoutEffect(() => {
    if (!view) {
      setGeometry(null);
      setRegions([]);
      return;
    }

    let cancelled = false;
    let frame = 0;
    let attempts = 0;

    const remeasure = (): boolean => {
      const geo = measureGeometry(view);
      setGeometry(geo);
      setRegions(computeRegions(view, issues, spec));
      return geo !== null;
    };

    // Vega renders asynchronously, so the graphic and its bounds may not
    // exist on the first tick. Retry on a few animation frames.
    const tryMeasure = () => {
      if (cancelled) return;
      const found = remeasure();
      if (!found && attempts++ < 30) {
        frame = requestAnimationFrame(tryMeasure);
      }
    };
    tryMeasure();

    const container = view.container?.();
    const observer = new ResizeObserver(() => remeasure());
    if (container) observer.observe(container);
    window.addEventListener('resize', remeasure);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', remeasure);
    };
  }, [view, issues, spec]);

  // Render nothing if the toggle is off, the chart isn't measured yet,
  // or there are no regions to show. (The guard is after all hooks so
  // hook order stays stable across renders, per React's rules.)
  if (!heatmapEnable || !geometry || regions.length === 0) return null;

  const clusters = orderByPrecedence(clusterRegions(regions));

  // Project a scene-space point onto the displayed pixel box, for
  // placing HTML badges crisply outside the stretched SVG.
  const sceneToPixel = (sceneX: number, sceneY: number) => ({
    x: ((sceneX - geometry.sceneMinX) / geometry.sceneWidth) * geometry.width,
    y: ((sceneY - geometry.sceneMinY) / geometry.sceneHeight) * geometry.height,
  });

  // More issues in one spot → a stronger glow (capped so it never goes
  // fully opaque and hides the chart beneath).
  const blobOpacity = (count: number) => Math.min(0.85, 0.55 + 0.12 * (count - 1));

  const setHover = (keys: string[]) => setState((s) => ({...s, hoveredIssueKeys: keys}));

  return (
    <div
      ref={overlayRef}
      className="a11y-heatmap"
      style={{left: geometry.left, top: geometry.top, width: geometry.width, height: geometry.height}}
    >
      <svg
        className="a11y-heatmap-svg"
        width={geometry.width}
        height={geometry.height}
        viewBox={`${geometry.sceneMinX} ${geometry.sceneMinY} ${geometry.sceneWidth} ${geometry.sceneHeight}`}
        preserveAspectRatio="none"
      >
        <defs>
          {/* Soft radial fills: a strong core that holds out to ~half
              the radius (the plateau), then eases to transparent at the
              edge. One per severity; objectBoundingBox units (the
              default) make a single gradient fit every ellipse.
              Tuning knobs: raise the mid stops to make blobs hold their
              colour longer before fading; lower them to fade sooner. */}
          <radialGradient id="a11y-blob-warning">
            <stop offset="0%" stopColor="rgb(230, 130, 20)" stopOpacity="0.72" />
            <stop offset="50%" stopColor="rgb(230, 130, 20)" stopOpacity="0.6" />
            <stop offset="80%" stopColor="rgb(230, 130, 20)" stopOpacity="0.34" />
            <stop offset="100%" stopColor="rgb(230, 130, 20)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="a11y-blob-info">
            <stop offset="0%" stopColor="rgb(30, 120, 225)" stopOpacity="0.68" />
            <stop offset="50%" stopColor="rgb(30, 120, 225)" stopOpacity="0.56" />
            <stop offset="80%" stopColor="rgb(30, 120, 225)" stopOpacity="0.3" />
            <stop offset="100%" stopColor="rgb(30, 120, 225)" stopOpacity="0" />
          </radialGradient>
        </defs>

        {clusters.map((cluster, ci) => {
          // Beyond the threshold, per-member rendering composites to fully
          // opaque and hides the data underneath. Fall back to one big
          // blob over the cluster's box so dense scatters stay readable.
          const useSingleBlob = cluster.memberBoxes.length > LARGE_CLUSTER_THRESHOLD;
          const blobs = useSingleBlob ? [cluster.box] : cluster.memberBoxes;

          return (
            <g
              key={ci}
              onMouseEnter={() => setHover([cluster.keys[0]])}
              onMouseLeave={() => setHover([])}
              onClick={() =>
                setState((s) => ({
                  ...s,
                  navItem: NAVBAR.Accessibility,
                  logs: false,
                  debugPane: true,
                  focusedIssueKey: cluster.keys[0],
                }))
              }
            >
              {blobs.map((b, bi) => {
                const cx = b.x + b.width / 2;
                const cy = b.y + b.height / 2;
                const rx = b.width / 2 + 10;
                const ry = b.height / 2 + 10;
                return (
                  <ellipse
                    key={bi}
                    className={`a11y-blob a11y-blob-${cluster.severity}`}
                    cx={cx}
                    cy={cy}
                    rx={rx}
                    ry={ry}
                    fill={`url(#a11y-blob-${cluster.severity})`}
                    opacity={blobOpacity(cluster.count)}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>

      {/* Count badges - crisp HTML in pixel space, one per multi-issue
          cluster. Non-interactive so the blob beneath still takes hover. */}
      {clusters.map((cluster, i) => {
        if (cluster.count < 2) return null;
        // Anchor to the largest member's top-right so the badge sits on a
        // visible mark, not in the empty space above a sparse row.
        const anchor = largestMemberBox(cluster.memberBoxes);
        const corner = sceneToPixel(anchor.x + anchor.width, anchor.y);
        return (
          <span key={i} className={`a11y-badge a11y-badge-${cluster.severity}`} style={{left: corner.x, top: corner.y}}>
            {cluster.count}
          </span>
        );
      })}
    </div>
  );
}
