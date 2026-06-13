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
 * The first defined value wins - this mirrors how Vega-Lite itself
 * resolves configuration.
 *
 * Composition-aware:
 *   The spec is walked as a tree, so font-bearing elements are found
 *   inside layer / concat / facet compositions, not just at the top
 *   level. (Without this, wrapping a chart in a `layer` - e.g. when the
 *   colour-only fix adds a text-label layer - would hide every font
 *   element from this rule.) Config is global, so it is always resolved
 *   from the ROOT spec; inline values come from the local view node.
 *
 * One issue per RENDERED element:
 *   Several spec locations can map to a single on-screen element:
 *     - sibling layers SHARE one x-axis and one y-axis,
 *     - channels mapping the SAME field SHARE one merged legend.
 *   Reporting each spec location separately would surface duplicate
 *   suggestions for what the reader sees as one element, so entries are
 *   de-duplicated by an `elementKey` (see dedupeByElement). Concatenated
 *   views do NOT share axes/legends, so their elements stay distinct.
 *
 * Two threshold tiers:
 *   - Title elements (chart title, axis titles, legend titles): 16 px
 *   - Label elements (axis labels, legend labels):              13 px
 *
 * JSON pointer strategy for defaults:
 *   When neither inline nor config provides a value, the pointer
 *   targets the most specific existing node where the author would
 *   add the fix:
 *     - If `axis` / `legend` object exists → point to it
 *       (author adds `labelFontSize` inside it)
 *     - Otherwise → point to the encoding channel
 *       (author adds `"axis": { "labelFontSize": 16 }`)
 */

// ─── Thresholds (pixels) ─────────────────────────────────────────

/** Minimum font size for title-level elements (chart title, axis/legend titles). */
export const TITLE_FONT_SIZE_THRESHOLD = 16;

/** Minimum font size for label-level elements (axis tick labels, legend labels). */
export const LABEL_FONT_SIZE_THRESHOLD = 13;

// ─── Vega-Lite default font sizes (pixels) ───────────────────────

//   Defaults from Vega's `style` block (axis/legend resolve through it):
//   style['guide-label']  fontSize 10  → axis labels, legend labels
//   style['guide-title']  fontSize 11  → axis titles, legend titles
//   style['group-title']  fontSize 13  → chart title
//   mark.text             fontSize 11  → text marks
// https://github.com/vega/vega/blob/main/packages/vega-parser/src/config.js
const DEFAULT_TITLE_FONT_SIZE = 13;
const DEFAULT_AXIS_LABEL_FONT_SIZE = 10;
const DEFAULT_AXIS_TITLE_FONT_SIZE = 11; // was 10
const DEFAULT_LEGEND_LABEL_FONT_SIZE = 10;
const DEFAULT_LEGEND_TITLE_FONT_SIZE = 11; // was 10
const DEFAULT_TEXT_MARK_FONT_SIZE = 11;

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
   *
   * Targeting strategy:
   *   - inline:  the specific property (e.g. /encoding/x/axis/labelFontSize)
   *              → Monaco underlines just the value like `9`
   *   - config:  the config property (e.g. /config/axis/labelFontSize)
   *              → Monaco underlines just the config value
   *   - default: the most specific existing parent where the fix goes:
   *              → /encoding/x/axis  (if axis object exists)
   *              → /encoding/x       (if no axis object yet)
   *
   * In a composition the pointer is prefixed with the view location,
   * e.g. /layer/0/encoding/x/axis/labelFontSize.
   */
  jsonPointer: string;

  /**
   * Identity of the RENDERED element this entry describes, used to
   * de-duplicate. Sibling layers share one x/y axis; channels on the
   * same field share one merged legend - entries with the same key are
   * collapsed to one. Keyed by coordinate system so concatenated views
   * (which have their own axes/legends) are never merged together.
   */
  elementKey: string;
}

/** Result of analyzing all font sizes in a spec. */
export interface FontSizeAnalysisResult {
  /** All text elements that were checked (after de-duplication). */
  entries: FontSizeEntry[];

  /** Entries that fell below their respective thresholds. */
  issues: FontSizeEntry[];
}

// ─── Generic helpers ─────────────────────────────────────────────

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

/**
 * Check whether a nested path exists and is an object in the spec.
 *
 * Used to decide the default pointer target: if the intermediate
 * object (axis/legend) exists, we point there instead of the channel.
 */
function hasObjectAtPath(obj: Record<string, any>, path: string[]): boolean {
  const value = readPath(obj, path);
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Extract the mark type from a view node.
 *
 * Handles both shorthand ("mark": "text") and object form
 * ("mark": {"type": "text", ...}).
 */
function resolveMarkType(node: Record<string, any>): string | null {
  const mark = node?.mark;
  if (typeof mark === 'string') return mark;
  if (mark && typeof mark === 'object' && typeof (mark as any).type === 'string') {
    return (mark as any).type;
  }
  return null;
}

// ─── Shared resolution logic ─────────────────────────────────────

interface ChannelFontSizeParams {
  label: string;
  configKey: string;
  role: FontSizeRole;
  /** The inline value if present, or undefined. */
  inlineValue: unknown;
  /** JSON pointer to the inline property (the value itself). */
  inlinePointer: string;
  /** Path to the config property. */
  configPath: string[];
  /** Vega-Lite default value. */
  defaultSize: number;
  /** JSON pointer for default issues (points to the best place to add the fix). */
  defaultPointer: string;
  /** Rendered-element identity for de-duplication. */
  elementKey: string;
}

/**
 * Resolve the effective font size for one property on one channel.
 *
 * Priority: inline → config → default. Inline values come from the
 * local view node (read by the caller into params.inlineValue); config
 * is global and so is read here from `rootSpec`.
 */
function resolveChannelFontSize(rootSpec: Record<string, any>, params: ChannelFontSizeParams): FontSizeEntry {
  const threshold = params.role === 'title' ? TITLE_FONT_SIZE_THRESHOLD : LABEL_FONT_SIZE_THRESHOLD;

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
      elementKey: params.elementKey,
    };
  }

  // 2. Config block (applies to all channels of this type) - from ROOT
  const configValue = readPath(rootSpec, params.configPath);
  if (typeof configValue === 'number') {
    return {
      label: params.label,
      configKey: params.configKey,
      role: params.role,
      effectiveSize: configValue,
      threshold,
      source: 'config',
      jsonPointer: '/' + params.configPath.join('/'),
      elementKey: params.elementKey,
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
    elementKey: params.elementKey,
  };
}

// ─── Chart title check ──────────────────────────────────────────

/**
 * Check the chart title font size for one view node.
 *
 * Resolution order:
 *   1. title.fontSize (when title is an object)
 *   2. config.title.fontSize
 *   3. Vega-Lite default (13 px)
 *
 * Skipped entirely when the view has no title property.
 */
function checkChartTitle(
  node: Record<string, any>,
  rootSpec: Record<string, any>,
  pointer: string,
  cs: string,
): FontSizeEntry | null {
  if (node?.title == null) return null;

  return resolveChannelFontSize(rootSpec, {
    label: 'Chart title',
    configKey: 'title.fontSize',
    role: 'title',
    inlineValue: typeof node.title === 'object' && !Array.isArray(node.title) ? node.title.fontSize : undefined,
    inlinePointer: `${pointer}/title/fontSize`,
    configPath: ['config', 'title', 'fontSize'],
    defaultSize: DEFAULT_TITLE_FONT_SIZE,
    defaultPointer: `${pointer}/title`,
    elementKey: `${cs}:title`,
  });
}

// ─── Per-axis checks ─────────────────────────────────────────────

/**
 * Axis-producing encoding channels.
 *
 * Only x and y: xOffset / yOffset position marks within a band but
 * render no labelled axis of their own, so they have no axis font to
 * check. (For colour-only detection they're treated separately - see
 * colorOnlyEncodingRule.)
 */
const AXIS_CHANNELS = ['x', 'y'];

/** Human-readable labels for axis channels. */
const AXIS_LABELS: Record<string, string> = {
  x: 'X-axis',
  y: 'Y-axis',
};

/** Orientation of an axis channel: starts with 'x' yields 'x', otherwise 'y'. */
function axisOrientation(channel: string): 'x' | 'y' {
  return channel[0] === 'x' ? 'x' : 'y';
}

/**
 * Pick the best JSON pointer for a default axis font-size issue.
 *
 * If the author already has an `axis` object on this channel, point to
 * it - that's where they'd add `labelFontSize`. Otherwise point to the
 * encoding channel - they need to create the `axis` block first.
 *
 *   { "x": { "field": "date", "axis": { "title": "Date" } } }
 *   → pointer: <prefix>/encoding/x/axis  (axis exists, add property here)
 *
 *   { "x": { "field": "date" } }
 *   → pointer: <prefix>/encoding/x       (no axis yet, create it here)
 */
function axisDefaultPointer(node: Record<string, any>, channel: string, pointer: string): string {
  return hasObjectAtPath(node, ['encoding', channel, 'axis'])
    ? `${pointer}/encoding/${channel}/axis`
    : `${pointer}/encoding/${channel}`;
}

/**
 * Check font sizes for one axis channel on one view node.
 *
 * Resolution order (per property):
 *   1. encoding.[channel].axis.[property]
 *   2. config.axis.[property]
 *   3. Vega-Lite default
 *
 * Returns 0–2 entries (one for labels, one for title). Value channels
 * (e.g. {"value": 40}) render no axis and are skipped.
 */
function checkAxisChannel(
  node: Record<string, any>,
  rootSpec: Record<string, any>,
  channel: string,
  pointer: string,
  cs: string,
): FontSizeEntry[] {
  const channelDef = node?.encoding?.[channel];
  if (!channelDef || typeof channelDef !== 'object') return [];
  if ('value' in channelDef) return []; // value channel → no axis

  const axisLabel = AXIS_LABELS[channel] ?? channel;
  const defaultPtr = axisDefaultPointer(node, channel, pointer);
  const orient = axisOrientation(channel);
  const entries: FontSizeEntry[] = [];

  // Labels
  entries.push(
    resolveChannelFontSize(rootSpec, {
      label: `${axisLabel} labels`,
      configKey: 'axis.labelFontSize',
      role: 'label',
      inlineValue: channelDef?.axis?.labelFontSize,
      inlinePointer: `${pointer}/encoding/${channel}/axis/labelFontSize`,
      configPath: ['config', 'axis', 'labelFontSize'],
      defaultSize: DEFAULT_AXIS_LABEL_FONT_SIZE,
      defaultPointer: defaultPtr,
      elementKey: `${cs}:axis:${orient}:label`,
    }),
  );

  // Title
  entries.push(
    resolveChannelFontSize(rootSpec, {
      label: `${axisLabel} title`,
      configKey: 'axis.titleFontSize',
      role: 'title',
      inlineValue: channelDef?.axis?.titleFontSize,
      inlinePointer: `${pointer}/encoding/${channel}/axis/titleFontSize`,
      configPath: ['config', 'axis', 'titleFontSize'],
      defaultSize: DEFAULT_AXIS_TITLE_FONT_SIZE,
      defaultPointer: defaultPtr,
      elementKey: `${cs}:axis:${orient}:title`,
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
 * Pick the best JSON pointer for a default legend font-size issue.
 * Same logic as axisDefaultPointer: point to the `legend` object if it
 * exists, otherwise to the channel itself.
 */
function legendDefaultPointer(node: Record<string, any>, channel: string, pointer: string): string {
  return hasObjectAtPath(node, ['encoding', channel, 'legend'])
    ? `${pointer}/encoding/${channel}/legend`
    : `${pointer}/encoding/${channel}`;
}

/**
 * Check font sizes for one legend channel on one view node.
 *
 * Resolution order (per property):
 *   1. encoding.[channel].legend.[property]
 *   2. config.legend.[property]
 *   3. Vega-Lite default
 *
 * Returns 0–2 entries (one for labels, one for title). Value channels
 * and field-less channels render no legend and are skipped. The
 * elementKey is keyed on the FIELD, so channels mapping the same field
 * (e.g. color + shape on "origin", merged by Vega-Lite into one legend)
 * collapse to a single element.
 */
function checkLegendChannel(
  node: Record<string, any>,
  rootSpec: Record<string, any>,
  channel: string,
  pointer: string,
  cs: string,
): FontSizeEntry[] {
  const channelDef = node?.encoding?.[channel];
  if (!channelDef || typeof channelDef !== 'object') return [];
  if ('value' in channelDef) return []; // value channel → no legend

  // A legend renders for channels that bind a field OR carry an
  // aggregate (e.g. `{aggregate: "count"}` produces a count-based
  // legend with no per-record field). Skip channels with neither.
  const field = typeof channelDef.field === 'string' ? channelDef.field : null;
  const aggregate = typeof channelDef.aggregate === 'string' ? channelDef.aggregate : null;
  if (!field && !aggregate) return [];

  // Dedup identity: channels mapping the SAME field share one merged
  // legend (e.g. color + shape on "origin" → one legend), so field
  // keys best when present. Aggregate-without-field channels don't
  // merge across channels, so the channel name disambiguates them.
  const legendIdentity = field ?? `aggregate-${channel}`;

  const legendLabel = LEGEND_LABELS[channel] ?? channel;
  const defaultPtr = legendDefaultPointer(node, channel, pointer);
  const entries: FontSizeEntry[] = [];

  // Labels
  entries.push(
    resolveChannelFontSize(rootSpec, {
      label: `${legendLabel} labels`,
      configKey: 'legend.labelFontSize',
      role: 'label',
      inlineValue: channelDef?.legend?.labelFontSize,
      inlinePointer: `${pointer}/encoding/${channel}/legend/labelFontSize`,
      configPath: ['config', 'legend', 'labelFontSize'],
      defaultSize: DEFAULT_LEGEND_LABEL_FONT_SIZE,
      defaultPointer: defaultPtr,
      elementKey: `${cs}:legend:${legendIdentity}:label`,
    }),
  );

  // Title
  entries.push(
    resolveChannelFontSize(rootSpec, {
      label: `${legendLabel} title`,
      configKey: 'legend.titleFontSize',
      role: 'title',
      inlineValue: channelDef?.legend?.titleFontSize,
      inlinePointer: `${pointer}/encoding/${channel}/legend/titleFontSize`,
      configPath: ['config', 'legend', 'titleFontSize'],
      defaultSize: DEFAULT_LEGEND_TITLE_FONT_SIZE,
      defaultPointer: defaultPtr,
      elementKey: `${cs}:legend:${legendIdentity}:title`,
    }),
  );

  return entries;
}

// ─── Text mark check ─────────────────────────────────────────────

/**
 * Check the font size of a `mark: "text"` layer.
 *
 * Text marks render data values as on-chart text (e.g. the row
 * labels around a Likert plot). That text is data-label text, so the
 * LABEL threshold (13 px) applies - same tier as axis tick labels and
 * legend entry labels.
 *
 * Resolution order:
 *   1. mark.fontSize          (only meaningful when mark is an object)
 *   2. config.text.fontSize
 *   3. Vega-Lite default (11 px)
 *
 * Skipped when the view's mark is not "text". Returns null rather than
 * an empty array because a view has at most one mark.
 *
 * elementKey embeds the full view pointer, so two sibling text-mark
 * layers stay distinct under dedupeByElement - they may carry
 * different inline sizes and must not collapse to one entry.
 */
function checkTextMark(
  node: Record<string, any>,
  rootSpec: Record<string, any>,
  pointer: string,
): FontSizeEntry | null {
  if (resolveMarkType(node) !== 'text') return null;

  const mark = node.mark;
  const inlineValue =
    mark && typeof mark === 'object' && !Array.isArray(mark) ? (mark as Record<string, any>).fontSize : undefined;

  return resolveChannelFontSize(rootSpec, {
    label: 'Text mark labels',
    configKey: 'text.fontSize',
    role: 'label',
    inlineValue,
    inlinePointer: `${pointer}/mark/fontSize`,
    configPath: ['config', 'text', 'fontSize'],
    defaultSize: DEFAULT_TEXT_MARK_FONT_SIZE,
    // The mark property is guaranteed to exist on this view (we
    // returned null otherwise), so it's a safe default target whether
    // it's a shorthand string or an object - Monaco can underline
    // either form.
    defaultPointer: `${pointer}/mark`,
    elementKey: `text-mark:${pointer}`,
  });
}

// ─── Composition walk ────────────────────────────────────────────

/** A view node in the spec tree, with its JSON-pointer prefix. */
interface ViewNode {
  node: Record<string, any>;
  pointer: string;
}

/**
 * Collect every view node in the spec, with its pointer prefix.
 *
 * Font-bearing elements live on units (encoding) and on view-level
 * titles, both of which can appear inside layer / concat / facet
 * compositions - not just at the top level. Container nodes (e.g. a
 * bare layer wrapper) are included too: they carry no encoding so
 * axis/legend checks skip them, but they may carry a `title`.
 */
function collectViewNodes(node: unknown, pointer: string, out: ViewNode[]): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  const obj = node as Record<string, any>;
  out.push({node: obj, pointer});

  if (Array.isArray(obj.layer)) {
    obj.layer.forEach((c: unknown, i: number) => collectViewNodes(c, `${pointer}/layer/${i}`, out));
  }
  for (const key of ['hconcat', 'vconcat', 'concat'] as const) {
    if (Array.isArray(obj[key])) {
      (obj[key] as unknown[]).forEach((c, i) => collectViewNodes(c, `${pointer}/${key}/${i}`, out));
    }
  }
  if (obj.spec) collectViewNodes(obj.spec, `${pointer}/spec`, out);
}

/**
 * The coordinate system a view belongs to, derived from its pointer.
 * Layers SHARE one (one x-axis, one y-axis, merged legends), so a
 * trailing "/layer/<n>" is stripped to collapse siblings; concatenated
 * views keep their own pointer and stay separate.
 *
 *   ""            → ""            (root)
 *   "/layer/0"    → ""            (layers share root's coord system)
 *   "/hconcat/0"  → "/hconcat/0"  (its own coord system)
 */
function coordSystemOf(viewPointer: string): string {
  return viewPointer.replace(/\/layer\/\d+$/, '');
}

// ─── De-duplication ──────────────────────────────────────────────

/** Source specificity for tie-breaking dedupe (higher = more specific). */
const SOURCE_RANK: Record<FontSizeEntry['source'], number> = {
  inline: 3,
  config: 2,
  default: 1,
};

/**
 * Collapse entries that describe the SAME rendered element to one.
 *
 * Keeps the most specific source (inline > config > default); on a tie,
 * keeps the smaller size (the more conservative reading). This means an
 * explicit value on a shared axis wins over another layer's default,
 * rather than producing a phantom issue for a size that isn't rendered.
 */
function dedupeByElement(entries: FontSizeEntry[]): FontSizeEntry[] {
  const byKey = new Map<string, FontSizeEntry>();
  for (const entry of entries) {
    const existing = byKey.get(entry.elementKey);
    if (!existing) {
      byKey.set(entry.elementKey, entry);
      continue;
    }
    const better =
      SOURCE_RANK[entry.source] > SOURCE_RANK[existing.source] ||
      (SOURCE_RANK[entry.source] === SOURCE_RANK[existing.source] && entry.effectiveSize < existing.effectiveSize);
    if (better) byKey.set(entry.elementKey, entry);
  }
  return [...byKey.values()];
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Analyze all font sizes in a Vega-Lite specification.
 *
 * Walks every view (handles layer / concat / facet, not just a single
 * top-level unit), checks the chart title, each axis channel, and each
 * legend channel, then de-duplicates so there is one entry per rendered
 * element. Config is resolved from the root spec; inline values from
 * each view node.
 *
 * @param spec - A parsed Vega-Lite specification object.
 * @returns Analysis result with all entries and those below threshold.
 */
export function analyzeFontSizes(spec: Record<string, any>): FontSizeAnalysisResult {
  const entries: FontSizeEntry[] = [];

  const views: ViewNode[] = [];
  collectViewNodes(spec, '', views);

  for (const {node, pointer} of views) {
    const cs = coordSystemOf(pointer);

    const titleEntry = checkChartTitle(node, spec, pointer, cs);
    if (titleEntry) entries.push(titleEntry);

    // Text marks rendering data values as on-chart text.
    const textMarkEntry = checkTextMark(node, spec, pointer);
    if (textMarkEntry) entries.push(textMarkEntry);

    if (node.encoding && typeof node.encoding === 'object') {
      for (const channel of AXIS_CHANNELS) {
        entries.push(...checkAxisChannel(node, spec, channel, pointer, cs));
      }
      for (const channel of LEGEND_CHANNELS) {
        entries.push(...checkLegendChannel(node, spec, channel, pointer, cs));
      }
    }
  }

  const deduped = dedupeByElement(entries);
  const issues = deduped.filter((entry) => entry.effectiveSize < entry.threshold);
  return {entries: deduped, issues};
}
