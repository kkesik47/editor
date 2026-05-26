/**
 * AccessibilityHeatmap (overlay) — CHUNK 2: real issue regions
 *
 * A transparent SVG layer positioned exactly over the rendered chart.
 * It reads the current accessibility issues, asks the resolvers where
 * each one lives on the chart, and paints a semi-transparent region
 * there — coloured by severity (warning = orange, info = blue).
 *
 * The component is self-contained: it pulls the live view, issue list,
 * and spec straight from app context, so it just needs to be dropped
 * into the chart container with no props.
 *
 * Coordinate mapping (proven in chunk 1): Vega draws in its own "scene"
 * coordinates whose origin is NOT the graphic's top-left (axis titles
 * and the chart title live in negative space). We size the overlay
 * <svg> to the displayed graphic but give it a viewBox taken from the
 * root scene bounds plus Vega's padding, with preserveAspectRatio
 * "none". The browser then maps scene coordinates onto the display
 * exactly the way Vega does, so resolver boxes (already absolute scene
 * coordinates) drop straight in with no per-box maths.
 *
 * Interaction (hover tooltip, click-to-jump, pane↔chart linking) is
 * chunk 4; for now regions are non-interactive so chart hovering is
 * untouched.
 */

import * as React from 'react';
import {useLayoutEffect, useRef, useState} from 'react';
import {useAppContext} from '../../context/app-context.js';
import type {SceneItem} from '../../features/accessibility/heatmap/boundingBox.js';
import {resolveIssueRegions, type IssueRegion} from '../../features/accessibility/heatmap/resolvers.js';
import './index.css';

interface OverlayGeometry {
  /** Displayed position/size of the graphic, relative to the .chart box. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Overlay <svg> viewBox in Vega scene coordinates: "minX minY w h". */
  viewBox: string;
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
 * offset parent) and build the scene-coordinate viewBox from the root
 * scene item's bounds plus padding. Returns null when the graphic or
 * its bounds aren't available yet.
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

  const minX = b.x1 - pad.left;
  const minY = b.y1 - pad.top;
  const vbWidth = b.x2 - b.x1 + pad.left + pad.right;
  const vbHeight = b.y2 - b.y1 + pad.top + pad.bottom;

  return {
    left: g.left - p.left,
    top: g.top - p.top,
    width: g.width,
    height: g.height,
    viewBox: `${minX} ${minY} ${vbWidth} ${vbHeight}`,
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

    // Vega renders asynchronously after the view is created, so the
    // graphic and its bounds may not exist on the first tick. Retry on
    // a few animation frames until they appear, then stop.
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

  return (
    <div
      ref={overlayRef}
      className="a11y-heatmap"
      style={{
        left: geometry.left,
        top: geometry.top,
        width: geometry.width,
        height: geometry.height,
      }}
    >
      <svg
        className="a11y-heatmap-svg"
        width={geometry.width}
        height={geometry.height}
        viewBox={geometry.viewBox}
        preserveAspectRatio="none"
      >
        {regions.map((region, i) => (
          <rect
            key={i}
            className={`a11y-region a11y-region-${region.issue.severity}`}
            x={region.box.x}
            y={region.box.y}
            width={region.box.width}
            height={region.box.height}
            onMouseEnter={() => setState((s) => ({...s, hoveredIssueKey: region.key}))}
            onMouseLeave={() => setState((s) => ({...s, hoveredIssueKey: null}))}
          />
        ))}
      </svg>
    </div>
  );
}