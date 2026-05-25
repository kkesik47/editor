/**
 * recommendations/colorOnlyEncodingRecs.ts
 *
 * Recommendations for issues from `colorOnlyEncodingRule`
 * (WCAG 2.1 – 1.4.1, Use of Color, Level A).
 *
 * The rule fires when a categorical field is encoded ONLY through a
 * color channel (color / fill / stroke) with no redundant non-color
 * channel. The fix is always the same shape — "add a non-color
 * channel for the same field" — but WHICH channel is the real
 * trade-off, and it depends on the mark type:
 *
 *   - shape       → renders only on POINT marks. circle/square lock
 *                   their shape (they are point with a fixed shape),
 *                   so the apply converts them to point first.
 *   - strokeDash  → renders only on STROKED path marks (line, rule).
 *                   NOT trail — trail is a filled, variable-width path,
 *                   so a dash pattern has nothing to dash.
 *   - column      → works for ANY mark (categories separated by
 *                   position instead of color), at the cost of layout
 *                   space; this is the catch-all so that e.g. a bar
 *                   chart coloured by category still gets a usable fix.
 *
 * Following the engine's principle: we surface every applicable
 * option side-by-side and let the author pick the trade-off, rather
 * than the tool silently choosing one.
 *
 * ─── Why the mark lists differ from colorOnlyEncodingRule.ts ──────
 *
 *   The rule file's SHAPE_MARKS / STROKE_DASH_MARKS drive its prose
 *   *suggestion* text, where naming circle/square/trail is harmless
 *   advice. Here the recommendations APPLY a real edit, so they must
 *   only offer channels that actually render — otherwise the author
 *   clicks a button and nothing changes (the circle+shape bug).
 */

import type {AccessibilityIssue} from '../types.js';
import type {Recommendation} from './types.js';
import {setEncodingChannel, convertMarkToPoint, parentPointer} from './specMutators.js';

// ─── Mark groupings ──────────────────────────────────────────────

/**
 * Marks for which we offer a `shape` encoding.
 *
 * All three are "point-like", but only `point` renders a varying
 * shape channel directly — circle and square have their shape locked.
 * We still offer shape for circle/square because the apply converts
 * them to `point` (kept filled) so the channel takes effect.
 */
const SHAPE_MARKS = ['point', 'circle', 'square'];

/**
 * Marks for which we offer a `strokeDash` encoding.
 *
 * Only stroked path marks: a dash pattern needs an actual stroke to
 * dash. `line` and `rule` are stroked. `trail` is excluded — it is a
 * filled, variable-width path, so strokeDash does not render on it.
 */
const STROKE_DASH_MARKS = ['line', 'rule'];

// ─── Shared evidence reader ─────────────────────────────────────

/**
 * The fields colorOnlyEncodingRule writes into issue.evidence that
 * we need to build a fix. `markType` may be null (e.g. mark resolved
 * from config), in which case the mark-specific recommendations
 * simply don't apply.
 */
interface ColorOnlyEvidence {
  channel: string;
  fieldName: string;
  fieldType: string;
  markType: string | null;
}

function readColorOnlyEvidence(issue: AccessibilityIssue): ColorOnlyEvidence | null {
  const e = issue.evidence as Record<string, unknown> | null | undefined;
  if (!e || typeof e !== 'object') return null;

  const {channel, fieldName, fieldType} = e;
  if (
    typeof channel !== 'string' ||
    typeof fieldName !== 'string' ||
    typeof fieldType !== 'string'
  ) {
    return null;
  }

  const markType = typeof e.markType === 'string' ? e.markType : null;
  return {channel, fieldName, fieldType, markType};
}

/**
 * The encoding object that owns the flagged color channel.
 *
 * The issue pointer addresses the channel itself, e.g.
 *   /encoding/color            → parent /encoding
 *   /layer/0/encoding/color    → parent /layer/0/encoding
 * so the parent pointer is exactly where a sibling channel goes.
 */
function encodingPointerFor(issue: AccessibilityIssue): string {
  return parentPointer(issue.jsonPointer);
}

/**
 * Pointer to the `mark` that owns this encoding. The mark is a
 * sibling of `encoding` on the same unit spec, so it sits one level
 * up from the encoding pointer:
 *   /encoding          → /mark
 *   /layer/0/encoding  → /layer/0/mark
 */
function markPointerFor(issue: AccessibilityIssue): string {
  const unitPointer = parentPointer(encodingPointerFor(issue));
  return unitPointer === '' ? '/mark' : `${unitPointer}/mark`;
}

// ─── Helper factory (for pure channel-add recommendations) ──────

/**
 * Build an "add a redundant channel" recommendation that needs no
 * mark change (strokeDash, column). The new channel reuses the field
 * name and type carried in the issue evidence, so the redundant
 * encoding tracks the same data as the color channel.
 */
function buildAddChannel(args: {
  id: string;
  label: string;
  description: string;
  channel: string;
  family: Recommendation['family'];
  appliesTo: (evidence: ColorOnlyEvidence, issue: AccessibilityIssue) => boolean;
}): Recommendation {
  return {
    id: args.id,
    label: args.label,
    description: args.description,
    family: args.family,

    applicableWhen(issue) {
      const evidence = readColorOnlyEvidence(issue);
      if (!evidence) return false;
      return args.appliesTo(evidence, issue);
    },

    apply(issue, spec) {
      const evidence = readColorOnlyEvidence(issue);
      if (!evidence) return spec;

      return setEncodingChannel(spec, encodingPointerFor(issue), args.channel, {
        field: evidence.fieldName,
        // Pass the field type through faithfully (nominal / ordinal)
        // rather than forcing nominal, so the redundant channel stays
        // true to how the data is actually typed.
        type: evidence.fieldType,
      });
    },
  };
}

// ─── Recommendations ─────────────────────────────────────────────

/**
 * Add shape encoding.
 *
 * Written out explicitly (not via buildAddChannel) because circle and
 * square marks lock their shape: the shape channel only renders on
 * `point` marks. When the mark is circle/square we convert it to point
 * (kept filled) so the added shape channel actually takes effect.
 */
export const addShapeEncoding: Recommendation = {
  id: 'color-only-add-shape',
  label: 'Add shape encoding',
  description:
    'Also encodes the field with marker shapes, so categories can be ' +
    'told apart without relying on color. Works well for point charts; ' +
    'shapes get hard to distinguish past about 6–8 categories. (For ' +
    'circle/square marks this switches them to point marks, kept filled, ' +
    'so the shapes can vary.)',
  family: 'redundancy',

  applicableWhen(issue) {
    const evidence = readColorOnlyEvidence(issue);
    if (!evidence) return false;
    return evidence.markType != null && SHAPE_MARKS.includes(evidence.markType);
  },

  apply(issue, spec) {
    const evidence = readColorOnlyEvidence(issue);
    if (!evidence) return spec;

    // Add the shape channel for the same field.
    let next = setEncodingChannel(spec, encodingPointerFor(issue), 'shape', {
      field: evidence.fieldName,
      type: evidence.fieldType,
    });

    // circle / square ignore the shape channel — convert to point so
    // the shapes actually render. point already renders shapes, so it
    // needs no conversion.
    if (evidence.markType === 'circle' || evidence.markType === 'square') {
      next = convertMarkToPoint(next, markPointerFor(issue));
    }

    return next;
  },
};

export const addStrokeDashEncoding = buildAddChannel({
  id: 'color-only-add-strokedash',
  label: 'Add dash pattern encoding',
  description:
    'Also encodes the field with line dash patterns, so series can be ' +
    'told apart without relying on color. Good for a handful of lines; ' +
    'only a few dash patterns are clearly distinguishable.',
  channel: 'strokeDash',
  family: 'redundancy',
  appliesTo: (evidence) =>
    evidence.markType != null && STROKE_DASH_MARKS.includes(evidence.markType),
});

export const addColumnFacet = buildAddChannel({
  id: 'color-only-add-column-facet',
  label: 'Split into small multiples',
  description:
    'Gives each category its own column (small multiples), so categories ' +
    'are separated by position instead of color. The most robust fix — ' +
    'works for any mark type, including bars and areas — but uses more ' +
    'space and changes the layout.',
  channel: 'column',
  family: 'restructure',
  // Faceting via encoding.column is only valid on a top-level unit
  // spec. Inside a layer / concat the encoding parent isn't '/encoding'
  // (it's e.g. '/layer/0/encoding'), and column there is invalid — those
  // would need the heavier `facet` operator, out of scope for now.
  appliesTo: (_evidence, issue) => encodingPointerFor(issue) === '/encoding',
});

// ─── Registry ────────────────────────────────────────────────────

export const colorOnlyEncodingRecommendations: Recommendation[] = [
  addShapeEncoding,
  addStrokeDashEncoding,
  addColumnFacet,
];