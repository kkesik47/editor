/**
 * recommendations/lightnessContrastRecs.ts
 *
 * Recommendations for issues from `lightnessContrastRule`.
 *
 * The rule emits four sub-IDs across two scale shapes:
 *
 *   :sequential-range         total L* range below threshold
 *   :non-monotonic            sequential lightness reverses direction
 *   :diverging-range          a diverging half spans too little L*
 *   :diverging-non-monotonic  a diverging half's lightness wobbles
 *
 * One registry entry `'vl-a11y-lightness-contrast'` covers all four
 * via prefix matching.
 *
 * Categorical scales are not covered: the lightness rule does not
 * apply to them (qualitative palettes trade lightness uniformity for
 * hue diversity by design — Brewer 2003; Wong 2011), so no
 * categorical issues are emitted and no recommendations are needed.
 *
 * ─── Trade-off space ─────────────────────────────────────────────
 *
 * The only sensible machine-applicable fix is a palette swap.
 * "Nudge a narrow range wider" or "remove a lightness reversal"
 * can't be expressed as a targeted edit; they're palette
 * redesigns. So we offer named replacements whose lightness
 * profile is GUARANTEED good — each candidate is verified using
 * the rule's own analysis functions (see lightnessAdjust.ts).
 *
 * ─── Why "guaranteed safe" matters here ──────────────────────────
 *
 * Lightness safety is a different property from CVD safety. A scheme
 * can be CVD-safe but lightness-poor, or vice versa. So we can't
 * just reuse `colorblindSafetyRecs.ts` candidate list and assume the
 * same recommendations work — each candidate is re-checked against
 * the *lightness* rule's actual thresholds.
 */

import type {AccessibilityIssue} from '../types.js';
import type {Recommendation} from './types.js';
import {setScheme, parentPointer} from './specMutators.js';
import {findLightnessSafeSchemes} from './lightnessAdjust.js';

// ─── Evidence reader ─────────────────────────────────────────────

interface LightnessEvidence {
  scaleType: 'sequential' | 'diverging';
  schemeName: string | null;
  /** The sampled gradient colours threaded through by the rule. */
  originalColors: string[];
}

function readLightnessEvidence(issue: AccessibilityIssue): LightnessEvidence | null {
  const e = issue.evidence as Record<string, unknown> | null | undefined;
  if (!e || typeof e !== 'object') return null;

  const scaleType = e.scaleType;
  if (scaleType !== 'sequential' && scaleType !== 'diverging') {
    return null;
  }

  const schemeName = typeof e.schemeName === 'string' ? e.schemeName : null;
  const originalColorsRaw = e.originalColors;
  const originalColors = Array.isArray(originalColorsRaw)
    ? (originalColorsRaw as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];

  return {scaleType, schemeName, originalColors};
}


// ─── Sequential / diverging: catalogue scheme swaps ─────────────

/**
 * Build a "swap to {scheme}" recommendation for one specific safe
 * candidate. The applicableWhen verifies safety at apply-time
 * against the issue's actual scale type, so a generated rec only
 * ever appears when it's genuinely a fix.
 */
function buildSchemeSwapRec(args: {
  schemeName: string;
  schemeType: 'sequential' | 'diverging';
  description: string;
}): Recommendation {
  return {
    id: `lightness-swap-to-${args.schemeName}`,
    label: `Switch to ${args.schemeName}`,
    description: args.description,
    family: 'replacement',

    applicableWhen(issue) {
      const ev = readLightnessEvidence(issue);
      if (!ev) return false;
      if (ev.scaleType !== args.schemeType) return false;
      // Don't offer to swap to the same scheme the chart already uses.
      if (
        ev.schemeName &&
        ev.schemeName.toLowerCase().replace(/-\d+$/, '') === args.schemeName
      ) {
        return false;
      }

      const safe = findLightnessSafeSchemes({
        scaleType: args.schemeType,
        excludeSchemeName: ev.schemeName,
      });
      return safe.some((s) => s.name === args.schemeName);
    },

    apply(issue, spec) {
      // The pointer addresses scale.range or scale.scheme; its parent
      // is the scale object — same shape as colorblindSafetyRecs and
      // contrastRecs.
      return setScheme(spec, parentPointer(issue.jsonPointer), args.schemeName);
    },
  };
}

// ─── Candidate list ─────────────────────────────────────────────
//
// One rec per candidate scheme. `applicableWhen` filters them to
// the right scale type per issue and verifies each is actually safe
// for the current chart (e.g. correct category count). The list is
// deliberately broader than colorblindSafetyRecs' — we want to give
// the lightness check a fair chance to find candidates, and the
// per-rec safety check makes false positives impossible.
//
// Diverging candidates were expanded in v2 to cover more of the Vega
// catalogue's diverging schemes. Spectral / redyellowblue /
// redyellowgreen / redgrey are deliberately omitted: spectral is
// rainbow-like (we recommend AWAY from it), the yellow-midpoint
// schemes often fail monotonicity, and redgrey has a deliberately
// gray half that fails range checks.

const CANDIDATES: {name: string; type: 'sequential' | 'diverging'; description: string}[] = [
  // ── Sequential ────────────────────────────────────────────────
  {
    name: 'viridis',
    type: 'sequential',
    description:
      'Perceptually uniform sequential palette with a wide, monotonic ' +
      'lightness range. Strong neutral default — readable in grayscale ' +
      'and CVD-safe as a bonus.',
  },
  {
    name: 'cividis',
    type: 'sequential',
    description:
      'Sequential palette designed so CVD and non-CVD viewers see ' +
      'nearly the same scale; lightness progresses monotonically across ' +
      'a wide range.',
  },
  {
    name: 'magma',
    type: 'sequential',
    description:
      'Perceptually uniform sequential palette with a warm hue ' +
      'progression (dark purple → orange → yellow). Best when you want ' +
      'a warm feel.',
  },
  {
    name: 'inferno',
    type: 'sequential',
    description:
      'Similar to magma with a slightly higher dynamic range. Good for ' +
      'data where the bright end matters most.',
  },
  {
    name: 'plasma',
    type: 'sequential',
    description:
      'Perceptually uniform sequential palette with a magenta-to-yellow ' +
      'progression.',
  },

  // ── Diverging ────────────────────────────────────────────────
  {
    name: 'blueorange',
    type: 'diverging',
    description:
      'Diverging blue-orange palette with smooth per-half lightness ' +
      'progressions. CVD-safer than red-green diverging palettes.',
  },
  {
    name: 'redblue',
    type: 'diverging',
    description:
      'Classic red-white-blue diverging palette. Each half has a steady ' +
      'lightness change toward its endpoint.',
  },
  {
    name: 'purpleorange',
    type: 'diverging',
    description:
      'Diverging palette on the purple-orange axis. Useful when red-blue ' +
      'or blue-orange clash with surrounding design.',
  },
  {
    name: 'brownbluegreen',
    type: 'diverging',
    description:
      'Earthy diverging palette running brown → white → teal-green. Each ' +
      'half has a steady lightness progression; a good fit for ' +
      'environmental / geographic data.',
  },
  {
    name: 'purplegreen',
    type: 'diverging',
    description:
      'Diverging palette on the purple-green axis. Decent CVD safety; ' +
      'useful when colour-coding requires distinguishing from the more ' +
      'common red-blue conventions.',
  },
  {
    name: 'pinkyellowgreen',
    type: 'diverging',
    description:
      'Diverging palette running pink → near-white → green. Vivid; ' +
      'best when surrounding design is muted enough to absorb the saturation.',
  },
];

function getSchemeSwapRecommendations(): Recommendation[] {
  return CANDIDATES.map((c) =>
    buildSchemeSwapRec({
      schemeName: c.name,
      schemeType: c.type,
      description: c.description,
    }),
  );
}

// ─── Registry ────────────────────────────────────────────────────

export const lightnessContrastRecommendations: Recommendation[] = [
  // Catalogue scheme swaps for sequential and diverging shapes —
  // the safety filter routes each candidate to the right issue.
  ...getSchemeSwapRecommendations(),
];