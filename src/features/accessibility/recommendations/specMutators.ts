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

// ─── Pointer-aware mutators ─────────────────────────────────────

/**
 * Set scale.scheme at the given pointer. If the scale currently has
 * an explicit `range`, that range is removed — scheme and range
 * cannot both be set on the same scale in Vega-Lite.
 */
export function setScheme(
  spec: VegaLiteSpec,
  scalePointer: string,
  schemeName: string,
): VegaLiteSpec {
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
export function setRange(
  spec: VegaLiteSpec,
  scalePointer: string,
  colors: string[],
): VegaLiteSpec {
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
    const existingRange = Array.isArray(current.range)
      ? [...(current.range as string[])]
      : [...fallbackColors];

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
export function setScaleType(
  spec: VegaLiteSpec,
  scalePointer: string,
  type: string,
): VegaLiteSpec {
  return updateAt(spec, scalePointer, (scale) => ({
    ...((scale as Record<string, unknown>) ?? {}),
    type,
  }));
}

// ─── Pointer helpers ────────────────────────────────────────────

/**
 * Apply an update function to the value at a JSON pointer.
 * Returns a new spec with the change; the original is untouched.
 * If the pointer doesn't resolve to a settable location, the spec
 * is returned unchanged.
 */
function updateAt(
  spec: VegaLiteSpec,
  pointer: string,
  update: (value: unknown) => unknown,
): VegaLiteSpec {
  const segments = parsePointer(pointer);
  const cloned = deepClone(spec);

  // Empty pointer means "the whole spec" — replace the root.
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