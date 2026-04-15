/**
 * contrastAnalysis.ts
 *
 * Computes WCAG 2.1 contrast ratios between foreground elements
 * (text, marks) and the chart background in a Vega-Lite spec.
 *
 * Uses the standard WCAG relative luminance formula and culori
 * for robust color parsing.
 *
 * WCAG thresholds checked:
 *   Text (AA)     : ≥ 4.5:1  (WCAG 2.1 – 1.4.3)
 *   Non-text (AA) : ≥ 3:1    (WCAG 2.1 – 1.4.11)
 *   Text (AAA)    : ≥ 7:1    (WCAG 2.1 – 1.4.6)
 *
 * Resolution order for text colors (same pattern as fontSizeAnalysis):
 *   1. Inline property  (e.g. encoding.x.axis.labelColor)
 *   2. Config block     (e.g. config.axis.labelColor)
 *   3. Vega-Lite default (#000000 — black)
 *
 * Background resolution order:
 *   1. spec.background
 *   2. config.background
 *   3. config.view.fill
 *   4. Default: #ffffff (white)
 */

import {parse, converter} from 'culori';
import {resolveScaleColors} from './colorblindSafety/resolveScaleColors.js';

// ─── Thresholds ──────────────────────────────────────────────────

/** WCAG 2.1 – 1.4.3: Minimum contrast for text (Level AA). */
export const TEXT_AA_THRESHOLD = 4.5;

/** WCAG 2.1 – 1.4.11: Minimum contrast for non-text elements (Level AA). */
export const NON_TEXT_AA_THRESHOLD = 3;

/** WCAG 2.1 – 1.4.6: Enhanced contrast for text (Level AAA). */
export const TEXT_AAA_THRESHOLD = 7;

// ─── Defaults ────────────────────────────────────────────────────

const DEFAULT_BACKGROUND = '#ffffff';
const DEFAULT_TEXT_COLOR = '#000000';

// ─── Color utilities ─────────────────────────────────────────────

const toRgb = converter('rgb');

/**
 * Parse any CSS color string to [r, g, b] in the 0–255 range.
 * Returns null if the color cannot be parsed.
 */
export function colorToRgb(color: string): [number, number, number] | null {
  const parsed = parse(color);
  if (!parsed) return null;

  const rgb = toRgb(parsed);
  if (!rgb) return null;

  return [
    Math.round(rgb.r * 255),
    Math.round(rgb.g * 255),
    Math.round(rgb.b * 255),
  ];
}

/**
 * Convert one sRGB channel (0–1) to linear light.
 *
 * This is the standard sRGB transfer function inverse,
 * as specified in WCAG 2.1's relative luminance definition.
 */
function srgbToLinear(c: number): number {
  return c <= 0.04045
    ? c / 12.92
    : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Compute WCAG 2.1 relative luminance from RGB values (0–255).
 *
 * Range: 0 (black) to 1 (white).
 */
export function relativeLuminance(r: number, g: number, b: number): number {
  return (
    0.2126 * srgbToLinear(r / 255) +
    0.7152 * srgbToLinear(g / 255) +
    0.0722 * srgbToLinear(b / 255)
  );
}

/**
 * Compute the WCAG contrast ratio between two CSS color strings.
 *
 * Returns a value from 1 (identical) to 21 (black on white).
 * Returns null if either color cannot be parsed.
 */
export function computeContrastRatio(
  color1: string,
  color2: string,
): number | null {
  const rgb1 = colorToRgb(color1);
  const rgb2 = colorToRgb(color2);
  if (!rgb1 || !rgb2) return null;

  const lum1 = relativeLuminance(...rgb1);
  const lum2 = relativeLuminance(...rgb2);

  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);

  return round2((lighter + 0.05) / (darker + 0.05));
}

/**
 * Check whether a background color is "light" (luminance > 0.5).
 *
 * Used to generate better suggestions: "use a darker color"
 * for light backgrounds, "use a lighter color" for dark ones.
 */
export function isLightBackground(color: string): boolean {
  const rgb = colorToRgb(color);
  if (!rgb) return true; // assume light if unparseable
  return relativeLuminance(...rgb) > 0.5;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Types ───────────────────────────────────────────────────────

/** One text element whose contrast was checked. */
export interface TextContrastEntry {
  /** Human-readable name, e.g. "X-axis labels". */
  label: string;

  /** Config key path, e.g. "axis.labelColor". */
  configKey: string;

  /** The resolved foreground color string. */
  foregroundColor: string;

  /** Contrast ratio against the background. */
  contrastRatio: number;

  /** Where the color came from: 'inline', 'config', or 'default'. */
  source: 'inline' | 'config' | 'default';

  /** JSON pointer to the property in the spec. */
  jsonPointer: string;
}

/** One mark or encoding color whose contrast was checked. */
export interface MarkContrastEntry {
  /** Human-readable name, e.g. "Mark fill". */
  label: string;

  /** The mark/encoding color string. */
  foregroundColor: string;

  /** Contrast ratio against the background. */
  contrastRatio: number;

  /** Where the color came from. */
  source: 'inline' | 'config' | 'default';

  /** JSON pointer to the color property. */
  jsonPointer: string;
}

/** Result of checking one color scale against the background. */
export interface ScaleContrastResult {
  /** Encoding channel: 'color', 'fill', or 'stroke'. */
  channel: string;

  /** Named scheme, if applicable. */
  schemeName?: string;

  /** JSON pointer to the scale property. */
  jsonPointer: string;

  /** Colors that fell below the 3:1 non-text threshold. */
  failingColors: {color: string; ratio: number; index: number}[];

  /** The lowest contrast ratio found in the scale. */
  worstRatio: number;
}

/** Full result of the contrast analysis. */
export interface ContrastAnalysisResult {
  /** Resolved background color. */
  backgroundColor: string;

  /** Where the background came from. */
  backgroundSource: string;

  /** All text elements checked. */
  textEntries: TextContrastEntry[];

  /** All mark/encoding colors checked. */
  markEntries: MarkContrastEntry[];

  /** All scale contrast results (only those with failures). */
  scaleResults: ScaleContrastResult[];
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Read a nested property from an object by following a path of keys.
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
 * Check whether a nested path exists and holds an object.
 */
function hasObjectAtPath(obj: Record<string, any>, path: string[]): boolean {
  const value = readPath(obj, path);
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

// ─── Background resolution ───────────────────────────────────────

/**
 * Resolve the effective background color of the chart.
 *
 * Checks: spec.background → config.background → config.view.fill → white.
 */
export function resolveBackground(
  spec: Record<string, any>,
): {color: string; source: string} {
  if (typeof spec.background === 'string') {
    return {color: spec.background, source: 'spec.background'};
  }

  const configBg = spec.config?.background;
  if (typeof configBg === 'string') {
    return {color: configBg, source: 'config.background'};
  }

  const viewFill = spec.config?.view?.fill;
  if (typeof viewFill === 'string') {
    return {color: viewFill, source: 'config.view.fill'};
  }

  return {color: DEFAULT_BACKGROUND, source: 'default'};
}

// ─── Text color resolution ───────────────────────────────────────

interface TextColorParams {
  label: string;
  configKey: string;
  inlineValue: unknown;
  inlinePointer: string;
  configPath: string[];
  defaultPointer: string;
}

/**
 * Resolve the effective text color for one element and compute
 * its contrast ratio against the background.
 *
 * Priority: inline → config → default (black).
 */
function resolveTextColor(
  spec: Record<string, any>,
  bg: string,
  params: TextColorParams,
): TextContrastEntry {
  // 1. Inline value
  if (typeof params.inlineValue === 'string') {
    const ratio = computeContrastRatio(params.inlineValue, bg);
    return {
      label: params.label,
      configKey: params.configKey,
      foregroundColor: params.inlineValue,
      contrastRatio: ratio ?? 0,
      source: 'inline',
      jsonPointer: params.inlinePointer,
    };
  }

  // 2. Config block
  const configValue = readPath(spec, params.configPath);
  if (typeof configValue === 'string') {
    const ratio = computeContrastRatio(configValue, bg);
    return {
      label: params.label,
      configKey: params.configKey,
      foregroundColor: configValue,
      contrastRatio: ratio ?? 0,
      source: 'config',
      jsonPointer: '/' + params.configPath.join('/'),
    };
  }

  // 3. Vega-Lite default (black)
  const ratio = computeContrastRatio(DEFAULT_TEXT_COLOR, bg);
  return {
    label: params.label,
    configKey: params.configKey,
    foregroundColor: DEFAULT_TEXT_COLOR,
    contrastRatio: ratio ?? 21,
    source: 'default',
    jsonPointer: params.defaultPointer,
  };
}

// ─── Chart title ─────────────────────────────────────────────────

/**
 * Check contrast of the chart title text.
 * Skipped when the spec has no title property.
 */
function checkTitleContrast(
  spec: Record<string, any>,
  bg: string,
): TextContrastEntry | null {
  if (spec?.title == null) return null;

  return resolveTextColor(spec, bg, {
    label: 'Chart title',
    configKey: 'title.color',
    inlineValue:
      typeof spec.title === 'object' && !Array.isArray(spec.title)
        ? spec.title.color
        : undefined,
    inlinePointer: '/title/color',
    configPath: ['config', 'title', 'color'],
    defaultPointer: '/title',
  });
}

// ─── Per-axis text colors ────────────────────────────────────────

const AXIS_CHANNELS = ['x', 'y', 'xOffset', 'yOffset'];

const AXIS_LABELS_MAP: Record<string, string> = {
  x: 'X-axis',
  y: 'Y-axis',
  xOffset: 'X-offset axis',
  yOffset: 'Y-offset axis',
};

function axisDefaultPointer(
  spec: Record<string, any>,
  channel: string,
): string {
  return hasObjectAtPath(spec, ['encoding', channel, 'axis'])
    ? `/encoding/${channel}/axis`
    : `/encoding/${channel}`;
}

/**
 * Check label and title text contrast for one axis channel.
 */
function checkAxisContrast(
  spec: Record<string, any>,
  bg: string,
  channel: string,
): TextContrastEntry[] {
  const channelDef = spec?.encoding?.[channel];
  if (!channelDef || typeof channelDef !== 'object') return [];

  const axisLabel = AXIS_LABELS_MAP[channel] ?? channel;
  const defaultPtr = axisDefaultPointer(spec, channel);

  return [
    // Label color
    resolveTextColor(spec, bg, {
      label: `${axisLabel} labels`,
      configKey: 'axis.labelColor',
      inlineValue: channelDef?.axis?.labelColor,
      inlinePointer: `/encoding/${channel}/axis/labelColor`,
      configPath: ['config', 'axis', 'labelColor'],
      defaultPointer: defaultPtr,
    }),
    // Title color
    resolveTextColor(spec, bg, {
      label: `${axisLabel} title`,
      configKey: 'axis.titleColor',
      inlineValue: channelDef?.axis?.titleColor,
      inlinePointer: `/encoding/${channel}/axis/titleColor`,
      configPath: ['config', 'axis', 'titleColor'],
      defaultPointer: defaultPtr,
    }),
  ];
}

// ─── Per-legend text colors ──────────────────────────────────────

const LEGEND_CHANNELS = ['color', 'fill', 'stroke', 'size', 'shape', 'opacity'];

const LEGEND_LABELS_MAP: Record<string, string> = {
  color: 'Color legend',
  fill: 'Fill legend',
  stroke: 'Stroke legend',
  size: 'Size legend',
  shape: 'Shape legend',
  opacity: 'Opacity legend',
};

function legendDefaultPointer(
  spec: Record<string, any>,
  channel: string,
): string {
  return hasObjectAtPath(spec, ['encoding', channel, 'legend'])
    ? `/encoding/${channel}/legend`
    : `/encoding/${channel}`;
}

/**
 * Check label and title text contrast for one legend channel.
 */
function checkLegendContrast(
  spec: Record<string, any>,
  bg: string,
  channel: string,
): TextContrastEntry[] {
  const channelDef = spec?.encoding?.[channel];
  if (!channelDef || typeof channelDef !== 'object') return [];

  const legendLabel = LEGEND_LABELS_MAP[channel] ?? channel;
  const defaultPtr = legendDefaultPointer(spec, channel);

  return [
    // Label color
    resolveTextColor(spec, bg, {
      label: `${legendLabel} labels`,
      configKey: 'legend.labelColor',
      inlineValue: channelDef?.legend?.labelColor,
      inlinePointer: `/encoding/${channel}/legend/labelColor`,
      configPath: ['config', 'legend', 'labelColor'],
      defaultPointer: defaultPtr,
    }),
    // Title color
    resolveTextColor(spec, bg, {
      label: `${legendLabel} title`,
      configKey: 'legend.titleColor',
      inlineValue: channelDef?.legend?.titleColor,
      inlinePointer: `/encoding/${channel}/legend/titleColor`,
      configPath: ['config', 'legend', 'titleColor'],
      defaultPointer: defaultPtr,
    }),
  ];
}

// ─── Mark colors (non-text) ─────────────────────────────────────

const COLOR_PROPS = ['color', 'fill', 'stroke'] as const;

/**
 * Walk the spec tree and collect all explicit mark/encoding colors,
 * computing their contrast ratio against the background.
 *
 * Handles layer, hconcat, vconcat, concat compositions.
 */
function collectMarkColors(
  node: unknown,
  pointer: string,
  bg: string,
  entries: MarkContrastEntry[],
): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;

  const obj = node as Record<string, any>;

  // Check mark properties at this level
  const mark = obj.mark;
  if (mark && typeof mark === 'object' && !Array.isArray(mark)) {
    for (const prop of COLOR_PROPS) {
      if (typeof mark[prop] === 'string') {
        const ratio = computeContrastRatio(mark[prop], bg);
        if (ratio != null) {
          entries.push({
            label: `Mark ${prop}`,
            foregroundColor: mark[prop],
            contrastRatio: ratio,
            source: 'inline',
            jsonPointer: `${pointer}/mark/${prop}`,
          });
        }
      }
    }
  }

  // Check encoding.{color,fill,stroke}.value at this level
  const encoding = obj.encoding;
  if (encoding && typeof encoding === 'object') {
    for (const prop of COLOR_PROPS) {
      const value = (encoding as Record<string, any>)[prop]?.value;
      if (typeof value === 'string') {
        const ratio = computeContrastRatio(value, bg);
        if (ratio != null) {
          entries.push({
            label: `Encoding ${prop} value`,
            foregroundColor: value,
            contrastRatio: ratio,
            source: 'inline',
            jsonPointer: `${pointer}/encoding/${prop}/value`,
          });
        }
      }
    }
  }

  // Recurse into compositions
  for (const key of ['layer', 'hconcat', 'vconcat', 'concat']) {
    const children = obj[key];
    if (Array.isArray(children)) {
      children.forEach((child, i) => {
        collectMarkColors(child, `${pointer}/${key}/${i}`, bg, entries);
      });
    }
  }
  if (obj.spec) {
    collectMarkColors(obj.spec, `${pointer}/spec`, bg, entries);
  }
}

// ─── Scale colors (non-text) ────────────────────────────────────

/**
 * Check each color in every explicit scale against the background.
 *
 * Returns one result per scale that has at least one failing color.
 * Reuses resolveScaleColors from the CVD rule for scale extraction.
 */
function checkScaleContrast(
  spec: Record<string, any>,
  bg: string,
): ScaleContrastResult[] {
  const scales = resolveScaleColors(spec);
  const results: ScaleContrastResult[] = [];

  for (const scale of scales) {
    const failing: {color: string; ratio: number; index: number}[] = [];
    let worstRatio = Infinity;

    for (let i = 0; i < scale.colors.length; i++) {
      const ratio = computeContrastRatio(scale.colors[i], bg);
      if (ratio == null) continue;

      if (ratio < worstRatio) worstRatio = ratio;

      if (ratio < NON_TEXT_AA_THRESHOLD) {
        failing.push({color: scale.colors[i], ratio: round2(ratio), index: i});
      }
    }

    if (failing.length > 0) {
      results.push({
        channel: scale.channel,
        schemeName: scale.schemeName,
        jsonPointer: scale.jsonPointer,
        failingColors: failing,
        worstRatio: worstRatio === Infinity ? 0 : round2(worstRatio),
      });
    }
  }

  return results;
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Analyze contrast ratios throughout a Vega-Lite specification.
 *
 * Checks three categories against the resolved background:
 *   1. Text elements — titles, axis labels, legend labels
 *   2. Mark colors  — explicit mark.color/fill/stroke, encoding values
 *   3. Scale colors — each color in explicit scale ranges/schemes
 *
 * Text color resolution: inline → config → Vega-Lite default (black).
 * Background resolution: spec → config → config.view.fill → white.
 *
 * @param spec - A parsed Vega-Lite specification object.
 */
export function analyzeContrast(
  spec: Record<string, any>,
): ContrastAnalysisResult {
  const bg = resolveBackground(spec);
  const textEntries: TextContrastEntry[] = [];

  // Chart title
  const titleEntry = checkTitleContrast(spec, bg.color);
  if (titleEntry) textEntries.push(titleEntry);

  // Per-axis checks
  for (const channel of AXIS_CHANNELS) {
    textEntries.push(...checkAxisContrast(spec, bg.color, channel));
  }

  // Per-legend checks
  for (const channel of LEGEND_CHANNELS) {
    textEntries.push(...checkLegendContrast(spec, bg.color, channel));
  }

  // Mark colors (walks compositions)
  const markEntries: MarkContrastEntry[] = [];
  collectMarkColors(spec, '', bg.color, markEntries);

  // Scale colors
  const scaleResults = checkScaleContrast(spec, bg.color);

  return {
    backgroundColor: bg.color,
    backgroundSource: bg.source,
    textEntries,
    markEntries,
    scaleResults,
  };
}