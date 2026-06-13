/**
 * recommendations/specMutators.ts
 *
 * Small, pure transforms that produce a NEW spec with a targeted
 * change. Recommendations compose these to express more complex
 * fixes; keeping mutators tiny means each one is easy to read,
 * easy to test, and reusable across rules.
 *
 * Pointer convention:
 *   All mutators take an RFC 6901 JSON pointer that addresses the
 *   target node (e.g. "/encoding/color/scale" for setScheme).
 *   The pointer is parsed inside `updateAt`; callers don't need to
 *   know the parsing rules.
 *
 * Mutators NEVER modify the input. They deep-clone first and
 * return the modified clone.
 */

import type {VegaLiteSpec} from './types.js';

const LABEL_FONT_SIZE_PX = 13;

// ─── Pointer-aware mutators ─────────────────────────────────────

/**
 * Set scale.scheme at the given pointer. If the scale currently has
 * an explicit `range`, that range is removed - scheme and range
 * cannot both be set on the same scale in Vega-Lite.
 */
export function setScheme(spec: VegaLiteSpec, scalePointer: string, schemeName: string): VegaLiteSpec {
  return updateAt(spec, scalePointer, (scale) => {
    const current = (scale as Record<string, unknown>) ?? {};
    const {range: _omit, ...rest} = current;
    return {...rest, scheme: schemeName};
  });
}

/**
 * Set scale.range to an explicit list of colors. If the scale
 * currently uses a named scheme, that scheme is removed.
 */
export function setRange(spec: VegaLiteSpec, scalePointer: string, colors: string[]): VegaLiteSpec {
  return updateAt(spec, scalePointer, (scale) => {
    const current = (scale as Record<string, unknown>) ?? {};
    const {scheme: _omit, ...rest} = current;
    return {...rest, range: colors};
  });
}

/**
 * Replace a single color in scale.range at the given index.
 *
 * If the scale currently uses a named scheme rather than an explicit
 * range, we materialise `fallbackColors` (typically the colors stored
 * in the issue's evidence) so we have something to edit. The scheme
 * is removed in that case so the new range takes effect.
 */
export function replaceColorInRange(
  spec: VegaLiteSpec,
  scalePointer: string,
  index: number,
  newColor: string,
  fallbackColors: string[],
): VegaLiteSpec {
  return updateAt(spec, scalePointer, (scale) => {
    const current = (scale as Record<string, unknown>) ?? {};
    const existingRange = Array.isArray(current.range) ? [...(current.range as string[])] : [...fallbackColors];

    if (index < 0 || index >= existingRange.length) return current;
    existingRange[index] = newColor;

    const {scheme: _omit, ...rest} = current;
    return {...rest, range: existingRange};
  });
}

/**
 * Set scale.type at the given pointer (e.g. 'quantize', 'ordinal').
 * Used by recommendations that switch the scale's interpolation
 * behaviour without changing colors.
 */
export function setScaleType(spec: VegaLiteSpec, scalePointer: string, type: string): VegaLiteSpec {
  return updateAt(spec, scalePointer, (scale) => ({
    ...((scale as Record<string, unknown>) ?? {}),
    type,
  }));
}

/**
 * Set (or replace) an encoding channel at the given encoding pointer.
 *
 * Used by recommendations that add a redundant non-color channel
 * (shape, strokeDash, column) for the same field, to satisfy
 * WCAG 1.4.1 (color must not be the sole means of conveying info).
 *
 * If the channel already exists it is overwritten. In practice the
 * triggering rule only fires when no other channel encodes the same
 * field, so an overwrite would only ever replace a channel encoding a
 * *different* field - a rare case the author can see and undo.
 *
 * e.g. setEncodingChannel(spec, '/encoding', 'shape',
 *        {field: 'category', type: 'nominal'})
 */
export function setEncodingChannel(
  spec: VegaLiteSpec,
  encodingPointer: string,
  channel: string,
  channelDef: Record<string, unknown>,
): VegaLiteSpec {
  return updateAt(spec, encodingPointer, (encoding) => {
    const current = (encoding as Record<string, unknown>) ?? {};
    return {...current, [channel]: channelDef};
  });
}

/**
 * Convert the mark at the given pointer to a `point` mark, so a
 * `shape` encoding channel actually renders varying shapes.
 *
 * `circle` and `square` lock their shape (they are `point` with a
 * fixed shape), so a shape channel on them is silently ignored.
 * Converting to `point` unlocks it. We set `filled: true` to keep the
 * filled look of circle/square (plain `point` is hollow), and we
 * preserve any other existing mark properties.
 *
 *   "mark": "circle"                    → {"type": "point", "filled": true}
 *   "mark": {"type": "square", size: 80} → {"type": "point", "size": 80, "filled": true}
 *   "mark": "point"                     → "point"  (unchanged)
 */
export function convertMarkToPoint(spec: VegaLiteSpec, markPointer: string): VegaLiteSpec {
  return updateAt(spec, markPointer, (mark) => {
    // String form: 'circle' / 'square' / 'point'.
    if (typeof mark === 'string') {
      if (mark === 'point') return 'point';
      return {type: 'point', filled: true}; // circle/square are filled by default
    }

    // Object form: keep existing properties, switch type to point.
    if (mark && typeof mark === 'object') {
      const m = mark as Record<string, unknown>;
      const next: Record<string, unknown> = {...m, type: 'point'};
      // Preserve circle/square's filled-by-default look unless the
      // author already set `filled` explicitly.
      if (next.filled === undefined && (m.type === 'circle' || m.type === 'square')) {
        next.filled = true;
      }
      return next;
    }

    return {type: 'point', filled: true};
  });
}

/**
 * Set a primitive value at the given pointer. The pointer must
 * address an existing settable location (the value's parent must
 * exist). Used by recommendations that replace a single value in
 * place - e.g. bumping an inline or config fontSize number.
 *
 *   setValueAt(spec, '/encoding/x/axis/labelFontSize', 13)
 */
export function setValueAt(spec: VegaLiteSpec, pointer: string, value: unknown): VegaLiteSpec {
  return updateAt(spec, pointer, () => value);
}

/**
 * Set config.<section>.<property> to a value, creating the `config`
 * and section objects if they don't exist yet. Used when the fix
 * belongs at the config level rather than on a specific node - e.g.
 * a too-small Vega-Lite *default* font size, where nothing is set
 * inline and writing to config is the cleanest, most robust place.
 *
 *   setConfigProperty(spec, 'axis', 'labelFontSize', 13)
 *     → { ..., config: { axis: { labelFontSize: 13 } } }
 *
 * Existing config / section properties are preserved.
 */
export function setConfigProperty(spec: VegaLiteSpec, section: string, property: string, value: unknown): VegaLiteSpec {
  return updateAt(spec, '/config', (config) => {
    const cfg = (config as Record<string, unknown>) ?? {};
    const sectionObj = (cfg[section] as Record<string, unknown>) ?? {};
    return {...cfg, [section]: {...sectionObj, [property]: value}};
  });
}

// ─── Pointer helpers ────────────────────────────────────────────

/**
 * Apply an update function to the value at a JSON pointer.
 * Returns a new spec with the change; the original is untouched.
 * If the pointer doesn't resolve to a settable location, the spec
 * is returned unchanged.
 */
function updateAt(spec: VegaLiteSpec, pointer: string, update: (value: unknown) => unknown): VegaLiteSpec {
  const segments = parsePointer(pointer);
  const cloned = deepClone(spec);

  // Empty pointer means "the whole spec" - replace the root.
  if (segments.length === 0) {
    return update(cloned) as VegaLiteSpec;
  }

  // Navigate to the parent container of the target key.
  let parent: any = cloned;
  for (let i = 0; i < segments.length - 1; i++) {
    if (parent == null || typeof parent !== 'object') return spec;
    parent = parent[segments[i]];
  }

  if (parent == null || typeof parent !== 'object') return spec;

  const lastKey = segments[segments.length - 1];
  parent[lastKey] = update(parent[lastKey]);

  return cloned;
}

/**
 * Parse an RFC 6901 JSON pointer into a list of unescaped segments.
 * "/encoding/color/scale" → ["encoding", "color", "scale"]
 *
 * Numeric segments are returned as strings; callers index into
 * arrays using string keys, which JavaScript handles correctly.
 */
function parsePointer(pointer: string): string[] {
  if (pointer === '' || pointer === '/') return [];
  return pointer
    .replace(/^\//, '')
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/**
 * Drop the last segment from a JSON pointer.
 * Used by recommendations whose issue pointer addresses a property
 * (e.g. /encoding/color/scale/scheme) but who need to mutate the
 * parent object (e.g. /encoding/color/scale).
 */
export function parentPointer(pointer: string): string {
  if (pointer === '' || pointer === '/') return '';
  const segments = pointer.split('/');
  segments.pop();
  return segments.join('/') || '';
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Wrap a unit spec into a two-layer spec that adds text labels for a
 * field, so a category encoded only via color also appears as
 * readable text next to each datum (WCAG 1.4.1).
 *
 * Unlike shape / strokeDash, the `text` channel only renders on a
 * `text` mark - you cannot add it to a point/bar/line. So the fix is
 * structural: keep the original mark as layer 0, and add a sibling
 * `text` mark (layer 1) that shares the same x/y and writes the field.
 *
 *   { "mark": "point", "encoding": { "x":…, "y":…, "color":… } }
 *     ↓
 *   { "layer": [
 *       { "mark": "point", "encoding": { "x":…, "y":…, "color":… } },
 *       { "mark": {"type":"text","dy":-8},
 *         "encoding": { "x":…, "y":…, "text": {field,type} } }
 *     ] }
 *
 * The x/y of the original encoding are copied onto the text layer so
 * the labels sit at the same positions. If the unit has no x or y
 * (rare for a color-only categorical chart), that channel is simply
 * omitted from the text layer.
 *
 * `dy: -8` nudges labels just above each datum so they don't sit
 * directly on top of the mark. It's a reasonable default; the author
 * can adjust it afterwards.
 */
export function addTextLabelLayer(
  spec: VegaLiteSpec,
  unitPointer: string,
  label: {field: string; type: string; color?: string},
): VegaLiteSpec {
  return updateAt(spec, unitPointer, (node) => {
    const unit = (node as Record<string, unknown>) ?? {};
    const encoding = (unit.encoding as Record<string, unknown>) ?? {};

    // Reuse the positional channels so labels line up with the marks.
    const positional: Record<string, unknown> = {};
    if (encoding.x !== undefined) positional.x = encoding.x;
    if (encoding.y !== undefined) positional.y = encoding.y;

    // Layer 0: the original mark + encoding, untouched.
    const originalLayer: Record<string, unknown> = {
      mark: unit.mark,
      encoding,
    };

    // Layer 1: a text mark writing the category field. We set `color`
    // explicitly when the caller supplied one - without it, the text
    // inherits Vega-Lite's default (black), which is invisible on
    // dark backgrounds. Callers that want the default can omit it.
    const textMark: Record<string, unknown> = {
      type: 'text',
      dy: -8,
      fontSize: LABEL_FONT_SIZE_PX,
    };
    if (label.color) textMark.color = label.color;

    const textLayer: Record<string, unknown> = {
      mark: textMark,
      encoding: {
        ...positional,
        text: {field: label.field, type: label.type},
      },
    };

    // Preserve any unit-level properties that aren't mark/encoding
    // (e.g. transform, name) by carrying them onto the wrapper.
    const {mark: _m, encoding: _e, ...rest} = unit;

    return {...rest, layer: [originalLayer, textLayer]};
  });
}
