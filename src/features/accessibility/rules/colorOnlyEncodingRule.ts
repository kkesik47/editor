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
  'x',
  'y',
  // NOTE: xOffset / yOffset are deliberately NOT here. They separate
  // marks spatially but render no labelled axis, so the only key to
  // which category is which remains the color legend - i.e. color is
  // still the sole *identifying* encoding (WCAG 1.4.1). By contrast
  // x / y / row / column / facet all render labelled ticks or headers,
  // which is why they DO count as redundant.
  'row',
  'column',
  'facet',
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
function hasRedundantEncoding(encoding: Record<string, any>, fieldName: string): boolean {
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

/**
 * The channel-def-shaped object that actually carries field/type for
 * this color encoding. Vega-Lite allows the categorical field and
 * type to live inside a `condition` block - the `color.condition`
 * branch is exactly where things like the brush/click pattern put
 * them - while `color` itself only carries the fallback `value`.
 * Without this resolution the rule misses every chart using that
 * pattern, because `channelDef.field` is undefined.
 *
 * The direct channel wins when it carries its own field; the
 * condition is only consulted as a fallback. Same precedence pattern
 * we use in resolveScaleColors' extractFromChannelDef split.
 */
function effectiveColorChannelDef(channelDef: Record<string, any>): Record<string, any> {
  if (resolveFieldName(channelDef)) return channelDef;
  const cond = channelDef.condition;
  if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
    return cond as Record<string, any>;
  }
  return channelDef;
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
  siblings: Record<string, any>[],
): void {
  const encoding = node?.encoding;
  if (!encoding || typeof encoding !== 'object') return;

  const markType = resolveMarkType(node);

  // Skip text marks - the text itself is a redundant encoding
  if (markType === 'text') return;

  for (const channel of COLOR_CHANNELS) {
    const channelDef = encoding[channel];
    if (!channelDef || typeof channelDef !== 'object') continue;

    const effective = effectiveColorChannelDef(channelDef);
    const fieldName = resolveFieldName(effective);
    if (!fieldName) continue;
    if (!isCategoricalType(effective)) continue;

    // Redundancy can come from the SAME encoding block (shape,
    // strokeDash, position…) OR from a SIBLING layer (e.g. a text
    // label layer added as a fix). Either one clears the issue.
    const covered =
      hasRedundantEncoding(encoding, fieldName) || siblingLayerProvidesRedundancy(encoding, siblings, fieldName);

    if (!covered) {
      results.push({
        channel,
        fieldName,
        fieldType: effective.type,
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
  siblings: Record<string, any>[] = [],
): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;

  const obj = node as Record<string, any>;

  // This node's own encoding - siblings (if any) can satisfy redundancy.
  checkNodeEncoding(obj, pointer, results, siblings);

  // Layer: each child sees the OTHER layers as redundancy context.
  if (Array.isArray(obj.layer)) {
    const layers = obj.layer as Record<string, any>[];
    layers.forEach((child, i) => {
      const childSiblings = layers.filter((_, j) => j !== i);
      walkSpec(child, `${pointer}/layer/${i}`, results, childSiblings);
    });
  }

  // Concatenations & nested spec: separate views, no cross-unit redundancy.
  for (const key of ['hconcat', 'vconcat', 'concat'] as const) {
    if (Array.isArray(obj[key])) {
      (obj[key] as unknown[]).forEach((child, i) => walkSpec(child, `${pointer}/${key}/${i}`, results));
    }
  }
  if (obj.spec) {
    walkSpec(obj.spec, `${pointer}/spec`, results);
  }
}

// ─── Issue builder ───────────────────────────────────────────────

function buildIssue(match: ColorOnlyMatch): AccessibilityIssue {
  const channelLabel = match.channel === 'color' ? 'color' : match.channel === 'fill' ? 'fill color' : 'stroke color';

  return {
    ruleId: `vl-a11y-color-only:${match.channel}`,
    severity: 'warning',

    message:
      `The "${match.fieldName}" field is encoded only through ` +
      `${channelLabel} (${match.fieldType}). WCAG 1.4.1 (Level A) ` +
      `requires that color is not the sole means of conveying ` +
      `information - users who cannot distinguish colors will not ` +
      `be able to tell categories apart.`,

    suggestion: buildSuggestion(match.markType, match.channel),

    jsonPointer: match.jsonPointer,
    editorVisibility: 'underline-key',

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

/**
 * Channels in a SIBLING layer that can redundantly encode a field.
 *
 * Only non-positional channels: a sibling text / shape / strokeDash
 * layer carrying the same field (and sitting at the same x/y) lets a
 * color-blind reader tell categories apart. This is what recognises
 * the "add a text-label layer" fix - the category becomes readable
 * text in a sibling layer rather than a channel on the original mark.
 */
const SIBLING_REDUNDANT_CHANNELS = ['text', 'shape', 'strokeDash'] as const;

/** Field name on a positional channel of an encoding, or null. */
function positionalField(encoding: Record<string, any>, channel: string): string | null {
  const def = encoding?.[channel];
  return def && typeof def === 'object' ? resolveFieldName(def) : null;
}

/**
 * Do two encodings share the same x AND y positional fields?
 *
 * Redundant marks (labels, shapes) in a sibling layer only help if
 * they sit at the same positions as the marks they describe. We
 * compare the x-field and y-field names; both matching (including
 * both absent) means the layers are co-located. A text annotation at
 * a different position would NOT count, which is the behaviour we want.
 */
function sharesPosition(a: Record<string, any>, b: Record<string, any>): boolean {
  return positionalField(a, 'x') === positionalField(b, 'x') && positionalField(a, 'y') === positionalField(b, 'y');
}

/**
 * Does any SIBLING layer redundantly encode `fieldName` for a mark at
 * this position? True when a sibling maps the same field on a
 * text / shape / strokeDash channel AND shares the same x/y.
 */
function siblingLayerProvidesRedundancy(
  targetEncoding: Record<string, any>,
  siblings: Record<string, any>[],
  fieldName: string,
): boolean {
  for (const sib of siblings) {
    const sibEncoding = sib?.encoding;
    if (!sibEncoding || typeof sibEncoding !== 'object') continue;
    if (!sharesPosition(targetEncoding, sibEncoding)) continue;

    for (const channel of SIBLING_REDUNDANT_CHANNELS) {
      const def = sibEncoding[channel];
      if (def && typeof def === 'object' && resolveFieldName(def) === fieldName) {
        return true;
      }
    }
  }
  return false;
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
