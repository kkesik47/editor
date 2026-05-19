/**
 * colorOnlyEncodingRule.ts
 *
 * Accessibility rule implementing WCAG 2.1 – 1.4.1 (Use of Color),
 * Level A: color must not be the sole means of conveying information.
 *
 * In data visualisation, this means that when a categorical field is
 * encoded to color/fill/stroke, the same field should also be encoded
 * through at least one non-color channel (shape, strokeDash, labels,
 * position, etc.) so users who cannot perceive color differences can
 * still interpret the chart.
 *
 * What this rule checks:
 *   - Walks encoding blocks (including layer/concat compositions)
 *   - For each color channel mapping a nominal or ordinal field,
 *     checks whether any other channel also maps the same field
 *   - Flags the color channel when no redundant encoding exists
 *
 * What this rule does NOT flag (to avoid noise):
 *   - Sequential/quantitative fields (handled by CVD + lightness rules)
 *   - Text marks (the text itself provides redundant encoding)
 *   - Single-value color channels (encoding.color.value = "#f00")
 *   - Channels where the same field is already on x or y (position)
 *
 * Suggestions are mark-type aware:
 *   - point marks  → suggest shape
 *   - line marks   → suggest strokeDash
 *   - bar marks    → suggest labels or direct annotation
 *   - other marks  → suggest shape or labels generically
 */

import type {AccessibilityIssue, AccessibilityRule} from '../types.js';
import {WCAG_USE_OF_COLOR, SHARMA_CVD_2023, OSIOBE_2024} from '../references.js';

// ─── Constants ───────────────────────────────────────────────────

/** Encoding channels that carry color information. */
const COLOR_CHANNELS = ['color', 'fill', 'stroke'] as const;

/** Field types considered categorical (unordered or ordered categories). */
const CATEGORICAL_TYPES = ['nominal', 'ordinal'];

/**
 * Non-color encoding channels that count as redundant.
 *
 * Includes spatial channels (x, y, row, column, facet) because
 * position is itself a non-color way to distinguish categories.
 * Also includes shape, strokeDash, text, tooltip, and detail.
 */
const REDUNDANT_CHANNELS = [
  'shape',
  'strokeDash',
  'text',
  'x', 'y',
  'xOffset', 'yOffset',
  'row', 'column', 'facet',
] as const;

/** Mark types where `shape` encoding is meaningful. */
const SHAPE_MARKS = ['point', 'circle', 'square'];

/** Mark types where `strokeDash` encoding is meaningful. */
const STROKE_DASH_MARKS = ['line', 'trail', 'rule'];

// ─── Types ───────────────────────────────────────────────────────

/** A color channel that was found without redundant encoding. */
interface ColorOnlyMatch {
  /** Which color channel: 'color', 'fill', or 'stroke'. */
  channel: string;

  /** The field name mapped to color. */
  fieldName: string;

  /** The field type: 'nominal' or 'ordinal'. */
  fieldType: string;

  /** JSON pointer to the encoding channel. */
  jsonPointer: string;

  /** The resolved mark type at this spec level. */
  markType: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Extract the mark type from a spec node.
 *
 * Handles both shorthand ("mark": "bar") and object form
 * ("mark": {"type": "bar", ...}).
 */
function resolveMarkType(node: Record<string, any>): string | null {
  const mark = node?.mark;
  if (typeof mark === 'string') return mark;
  if (mark && typeof mark === 'object' && typeof mark.type === 'string') {
    return mark.type;
  }
  return null;
}

/**
 * Extract the field name from an encoding channel definition.
 *
 * Handles standard field references and also `aggregate` encodings
 * that still have a field property.
 */
function resolveFieldName(channelDef: Record<string, any>): string | null {
  if (typeof channelDef?.field === 'string') return channelDef.field;
  return null;
}

/**
 * Check whether a field type is categorical (nominal or ordinal).
 */
function isCategoricalType(channelDef: Record<string, any>): boolean {
  return CATEGORICAL_TYPES.includes(channelDef?.type);
}

/**
 * Check whether any redundant (non-color) channel in the encoding
 * block maps the same field name.
 */
function hasRedundantEncoding(
  encoding: Record<string, any>,
  fieldName: string,
): boolean {
  for (const channel of REDUNDANT_CHANNELS) {
    const channelDef = encoding[channel];
    if (!channelDef || typeof channelDef !== 'object') continue;

    const otherField = resolveFieldName(channelDef);
    if (otherField === fieldName) return true;
  }

  return false;
}

/**
 * Build a mark-type-aware suggestion string.
 */
function buildSuggestion(markType: string | null, channel: string): string {
  const base = `Add a non-color encoding for the same field to comply with WCAG 1.4.1 (Use of Color).`;

  if (markType && SHAPE_MARKS.includes(markType)) {
    return (
      `${base} For "${markType}" marks, adding a "shape" encoding ` +
      `for the same field is the most effective approach. ` +
      `Example: "shape": {"field": "...", "type": "nominal"}.`
    );
  }

  if (markType && STROKE_DASH_MARKS.includes(markType)) {
    return (
      `${base} For "${markType}" marks, adding a "strokeDash" ` +
      `encoding for the same field works well. ` +
      `Example: "strokeDash": {"field": "...", "type": "nominal"}.`
    );
  }

  if (markType === 'bar' || markType === 'rect') {
    return (
      `${base} For "${markType}" marks, consider adding direct ` +
      `labels (text marks in a layer) or using "xOffset"/"yOffset" ` +
      `to separate categories by position.`
    );
  }

  if (markType === 'area') {
    return (
      `${base} For "area" marks, consider adding direct labels ` +
      `(text marks in a layer) or using strokeDash on the area ` +
      `boundaries to differentiate categories.`
    );
  }

  return (
    `${base} Consider adding "shape", "strokeDash", or direct ` +
    `labels so the information is not conveyed by color alone.`
  );
}

// ─── Spec walker ─────────────────────────────────────────────────

/**
 * Walk one spec node and check its encoding block for color-only
 * categorical fields.
 */
function checkNodeEncoding(
  node: Record<string, any>,
  pointer: string,
  results: ColorOnlyMatch[],
): void {
  const encoding = node?.encoding;
  if (!encoding || typeof encoding !== 'object') return;

  const markType = resolveMarkType(node);

  // Skip text marks — the text itself is a redundant encoding
  if (markType === 'text') return;

  for (const channel of COLOR_CHANNELS) {
    const channelDef = encoding[channel];
    if (!channelDef || typeof channelDef !== 'object') continue;

    // Skip value-only channels (no field mapping)
    const fieldName = resolveFieldName(channelDef);
    if (!fieldName) continue;

    // Skip non-categorical fields
    if (!isCategoricalType(channelDef)) continue;

    // Check for any redundant non-color encoding of the same field
    if (!hasRedundantEncoding(encoding, fieldName)) {
      results.push({
        channel,
        fieldName,
        fieldType: channelDef.type,
        jsonPointer: `${pointer}/encoding/${channel}`,
        markType,
      });
    }
  }
}

/**
 * Walk the full spec tree (including compositions) looking for
 * color-only categorical encodings.
 */
function walkSpec(
  node: unknown,
  pointer: string,
  results: ColorOnlyMatch[],
): void {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    node.forEach((item, i) => walkSpec(item, `${pointer}/${i}`, results));
    return;
  }

  const obj = node as Record<string, any>;

  // Check encoding at this level
  checkNodeEncoding(obj, pointer, results);

  // Recurse into compositional properties
  for (const key of ['layer', 'hconcat', 'vconcat', 'concat', 'spec']) {
    if (obj[key]) {
      walkSpec(obj[key], `${pointer}/${key}`, results);
    }
  }
}

// ─── Issue builder ───────────────────────────────────────────────

function buildIssue(match: ColorOnlyMatch): AccessibilityIssue {
  const channelLabel =
    match.channel === 'color' ? 'color'
    : match.channel === 'fill' ? 'fill color'
    : 'stroke color';

  return {
    ruleId: `vl-a11y-color-only:${match.channel}`,
    severity: 'warning',

    message:
      `The "${match.fieldName}" field is encoded only through ` +
      `${channelLabel} (${match.fieldType}). WCAG 1.4.1 (Level A) ` +
      `requires that color is not the sole means of conveying ` +
      `information — users who cannot distinguish colors will not ` +
      `be able to tell categories apart.`,

    suggestion: buildSuggestion(match.markType, match.channel),

    jsonPointer: match.jsonPointer,

    evidence: {
      wcagLevel: 'A',
      wcagCriterion: '1.4.1',
      channel: match.channel,
      fieldName: match.fieldName,
      fieldType: match.fieldType,
      markType: match.markType,
    },
  };
}

// ─── The rule ────────────────────────────────────────────────────

export const colorOnlyEncodingRule: AccessibilityRule = {
  id: 'vl-a11y-color-only',

  description:
    'WCAG 2.1 – 1.4.1 (Use of Color), Level A: checks whether ' +
    'categorical fields encoded to color also have at least one ' +
    'non-color redundant encoding such as shape, strokeDash, or labels.',
  references: [WCAG_USE_OF_COLOR, SHARMA_CVD_2023, OSIOBE_2024],
  evaluate(spec: Record<string, any>): AccessibilityIssue[] {
    const matches: ColorOnlyMatch[] = [];
    walkSpec(spec, '', matches);
    return matches.map(buildIssue);
  },
};