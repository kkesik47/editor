/**
 * fontSizeAnalysis.ts
 *
 * Extracts effective font sizes from a Vega-Lite specification and
 * checks them against minimum readability thresholds.
 *
 * Font sizes in Vega-Lite are always specified in **pixels** (not
 * points). This module resolves the effective font size for each
 * text element by checking, in priority order:
 *
 *   1. Inline properties  (e.g. encoding.x.axis.labelFontSize)
 *   2. Config block       (e.g. config.axis.labelFontSize)
 *   3. Vega-Lite defaults (hardcoded fallback values)
 *
 * The first defined value wins — this mirrors how Vega-Lite itself
 * resolves configuration.
 *
 * Checks are per-channel: each axis (x, y) and each legend channel
 * (color, size, etc.) is checked independently. This ensures the
 * underline points to the specific channel, not the whole encoding.
 *
 * Two threshold tiers:
 *   - Title elements (chart title, axis titles, legend titles): 16 px
 *   - Label elements (axis labels, legend labels):              13 px
 */

// ─── Thresholds (pixels) ─────────────────────────────────────────

/** Minimum font size for title-level elements (chart title, axis/legend titles). */
export const TITLE_FONT_SIZE_THRESHOLD = 16;

/** Minimum font size for label-level elements (axis tick labels, legend labels). */
export const LABEL_FONT_SIZE_THRESHOLD = 13;

// ─── Vega-Lite default font sizes (pixels) ───────────────────────

const DEFAULT_TITLE_FONT_SIZE = 13;
const DEFAULT_AXIS_LABEL_FONT_SIZE = 10;
const DEFAULT_AXIS_TITLE_FONT_SIZE = 10;
const DEFAULT_LEGEND_LABEL_FONT_SIZE = 10;
const DEFAULT_LEGEND_TITLE_FONT_SIZE = 10;

// ─── Types ───────────────────────────────────────────────────────

/** Whether this element is a title or a label (determines the threshold). */
export type FontSizeRole = 'title' | 'label';

/** One text element whose font size was checked. */
export interface FontSizeEntry {
  /** Human-readable name, e.g. "Chart title" or "X-axis labels". */
  label: string;

  /** The config key path, e.g. "title.fontSize" or "axis.labelFontSize". */
  configKey: string;

  /** Whether this element uses the title or label threshold. */
  role: FontSizeRole;

  /** The effective font size in pixels (resolved from spec → config → default). */
  effectiveSize: number;

  /** The minimum size required for this element. */
  threshold: number;

  /** Where the value came from: 'inline', 'config', or 'default'. */
  source: 'inline' | 'config' | 'default';

  /**
   * JSON Pointer to the property in the spec.
   * - inline:  points to the specific property (e.g. /encoding/x/axis/labelFontSize)
   * - config:  points to the config property (e.g. /config/axis/labelFontSize)
   * - default: points to the channel that uses this font (e.g. /encoding/x)
   */
  jsonPointer: string;
}

/** Result of analyzing all font sizes in a spec. */
export interface FontSizeAnalysisResult {
  /** All text elements that were checked. */
  entries: FontSizeEntry[];

  /** Entries that fell below their respective thresholds. */
  issues: FontSizeEntry[];
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Read a nested property from an object by following a path of keys.
 * Returns undefined if any segment is missing.
 */
function readPath(obj: Record<string, any>, path: string[]): unknown {
  let current: any = obj;

  for (const key of path) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[key];
  }

  return current;
}

// ─── Shared resolution logic ─────────────────────────────────────

interface ChannelFontSizeParams {
  label: string;
  configKey: string;
  role: FontSizeRole;
  /** The inline value if present, or undefined. */
  inlineValue: unknown;
  /** JSON pointer to the inline property. */
  inlinePointer: string;
  /** Path to the config property. */
  configPath: string[];
  /** Vega-Lite default value. */
  defaultSize: number;
  /** JSON pointer for default issues (points to the channel). */
  defaultPointer: string;
}

/**
 * Resolve the effective font size for one property on one channel.
 *
 * Priority: inline → config → default.
 */
function resolveChannelFontSize(
  spec: Record<string, any>,
  params: ChannelFontSizeParams,
): FontSizeEntry {
  const threshold = params.role === 'title'
    ? TITLE_FONT_SIZE_THRESHOLD
    : LABEL_FONT_SIZE_THRESHOLD;

  // 1. Inline value on this specific channel
  if (typeof params.inlineValue === 'number') {
    return {
      label: params.label,
      configKey: params.configKey,
      role: params.role,
      effectiveSize: params.inlineValue,
      threshold,
      source: 'inline',
      jsonPointer: params.inlinePointer,
    };
  }

  // 2. Config block (applies to all channels of this type)
  const configValue = readPath(spec, params.configPath);
  if (typeof configValue === 'number') {
    return {
      label: params.label,
      configKey: params.configKey,
      role: params.role,
      effectiveSize: configValue,
      threshold,
      source: 'config',
      jsonPointer: '/' + params.configPath.join('/'),
    };
  }

  // 3. Vega-Lite default
  return {
    label: params.label,
    configKey: params.configKey,
    role: params.role,
    effectiveSize: params.defaultSize,
    threshold,
    source: 'default',
    jsonPointer: params.defaultPointer,
  };
}

// ─── Chart title check ──────────────────────────────────────────

/**
 * Check the chart title font size.
 *
 * Resolution order:
 *   1. title.fontSize (when title is an object)
 *   2. config.title.fontSize
 *   3. Vega-Lite default (13 px)
 *
 * Skipped entirely when the spec has no title property.
 */
function checkChartTitle(spec: Record<string, any>): FontSizeEntry | null {
  if (spec?.title == null) return null;

  return resolveChannelFontSize(spec, {
    label: 'Chart title',
    configKey: 'title.fontSize',
    role: 'title',
    inlineValue: typeof spec.title === 'object' && !Array.isArray(spec.title)
      ? spec.title.fontSize
      : undefined,
    inlinePointer: '/title/fontSize',
    configPath: ['config', 'title', 'fontSize'],
    defaultSize: DEFAULT_TITLE_FONT_SIZE,
    defaultPointer: '/title',
  });
}

// ─── Per-axis checks ─────────────────────────────────────────────

/** Axis-producing encoding channels. */
const AXIS_CHANNELS = ['x', 'y', 'xOffset', 'yOffset'];

/** Human-readable labels for axis channels. */
const AXIS_LABELS: Record<string, string> = {
  x: 'X-axis',
  y: 'Y-axis',
  xOffset: 'X-offset axis',
  yOffset: 'Y-offset axis',
};

/**
 * Check font sizes for one axis channel.
 *
 * Resolution order (per property):
 *   1. encoding.[channel].axis.[property]
 *   2. config.axis.[property]
 *   3. Vega-Lite default
 *
 * Returns 0–2 entries (one for labels, one for title).
 */
function checkAxisChannel(
  spec: Record<string, any>,
  channel: string,
): FontSizeEntry[] {
  const channelDef = spec?.encoding?.[channel];
  if (!channelDef || typeof channelDef !== 'object') return [];

  const axisLabel = AXIS_LABELS[channel] ?? channel;
  const entries: FontSizeEntry[] = [];

  // Check labelFontSize
  entries.push(
    resolveChannelFontSize(spec, {
      label: `${axisLabel} labels`,
      configKey: 'axis.labelFontSize',
      role: 'label',
      inlineValue: channelDef?.axis?.labelFontSize,
      inlinePointer: `/encoding/${channel}/axis/labelFontSize`,
      configPath: ['config', 'axis', 'labelFontSize'],
      defaultSize: DEFAULT_AXIS_LABEL_FONT_SIZE,
      defaultPointer: `/encoding/${channel}`,
    }),
  );

  // Check titleFontSize
  entries.push(
    resolveChannelFontSize(spec, {
      label: `${axisLabel} title`,
      configKey: 'axis.titleFontSize',
      role: 'title',
      inlineValue: channelDef?.axis?.titleFontSize,
      inlinePointer: `/encoding/${channel}/axis/titleFontSize`,
      configPath: ['config', 'axis', 'titleFontSize'],
      defaultSize: DEFAULT_AXIS_TITLE_FONT_SIZE,
      defaultPointer: `/encoding/${channel}`,
    }),
  );

  return entries;
}

// ─── Per-legend checks ───────────────────────────────────────────

/** Legend-producing encoding channels. */
const LEGEND_CHANNELS = ['color', 'fill', 'stroke', 'size', 'shape', 'opacity'];

/** Human-readable labels for legend channels. */
const LEGEND_LABELS: Record<string, string> = {
  color: 'Color legend',
  fill: 'Fill legend',
  stroke: 'Stroke legend',
  size: 'Size legend',
  shape: 'Shape legend',
  opacity: 'Opacity legend',
};

/**
 * Check font sizes for one legend channel.
 *
 * Resolution order (per property):
 *   1. encoding.[channel].legend.[property]
 *   2. config.legend.[property]
 *   3. Vega-Lite default
 *
 * Returns 0–2 entries (one for labels, one for title).
 */
function checkLegendChannel(
  spec: Record<string, any>,
  channel: string,
): FontSizeEntry[] {
  const channelDef = spec?.encoding?.[channel];
  if (!channelDef || typeof channelDef !== 'object') return [];

  const legendLabel = LEGEND_LABELS[channel] ?? channel;
  const entries: FontSizeEntry[] = [];

  // Check labelFontSize
  entries.push(
    resolveChannelFontSize(spec, {
      label: `${legendLabel} labels`,
      configKey: 'legend.labelFontSize',
      role: 'label',
      inlineValue: channelDef?.legend?.labelFontSize,
      inlinePointer: `/encoding/${channel}/legend/labelFontSize`,
      configPath: ['config', 'legend', 'labelFontSize'],
      defaultSize: DEFAULT_LEGEND_LABEL_FONT_SIZE,
      defaultPointer: `/encoding/${channel}`,
    }),
  );

  // Check titleFontSize
  entries.push(
    resolveChannelFontSize(spec, {
      label: `${legendLabel} title`,
      configKey: 'legend.titleFontSize',
      role: 'title',
      inlineValue: channelDef?.legend?.titleFontSize,
      inlinePointer: `/encoding/${channel}/legend/titleFontSize`,
      configPath: ['config', 'legend', 'titleFontSize'],
      defaultSize: DEFAULT_LEGEND_TITLE_FONT_SIZE,
      defaultPointer: `/encoding/${channel}`,
    }),
  );

  return entries;
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Analyze all font sizes in a Vega-Lite specification.
 *
 * Checks each text element individually:
 *   - Chart title (if present)
 *   - Each axis channel (x, y, etc.) — labels and title separately
 *   - Each legend channel (color, size, etc.) — labels and title separately
 *
 * Resolution per element: inline → config → Vega-Lite default.
 * Default issues point to the specific channel (e.g. /encoding/x),
 * not the whole encoding block.
 *
 * @param spec - A parsed Vega-Lite specification object.
 * @returns Analysis result with all entries and those below threshold.
 */
export function analyzeFontSizes(
  spec: Record<string, any>,
): FontSizeAnalysisResult {
  const entries: FontSizeEntry[] = [];

  // Chart title
  const titleEntry = checkChartTitle(spec);
  if (titleEntry) {
    entries.push(titleEntry);
  }

  // Per-axis checks
  for (const channel of AXIS_CHANNELS) {
    entries.push(...checkAxisChannel(spec, channel));
  }

  // Per-legend checks
  for (const channel of LEGEND_CHANNELS) {
    entries.push(...checkLegendChannel(spec, channel));
  }

  const issues = entries.filter((entry) => entry.effectiveSize < entry.threshold);
  return {entries, issues};
}