/**
 * recommendations/lightnessContrastRecs.ts
 *
 * Recommendations for issues from `lightnessContrastRule`.
 *
 * The rule emits five sub-IDs across three scale shapes:
 *
 *   :categorical              pairs too close in L* (merge in grayscale)
 *   :sequential-range         total L* range below threshold
 *   :non-monotonic            sequential lightness reverses direction
 *   :diverging-range          a diverging half spans too little L*
 *   :diverging-non-monotonic  a diverging half's lightness wobbles
 *
 * One registry entry `'vl-a11y-lightness-contrast'` covers all five
 * via prefix matching.
 *
 * ─── Trade-off space per scale shape ─────────────────────────────
 *
 *   Sequential / diverging:
 *     The only sensible machine-applicable fix is a palette swap.
 *     "Nudge a narrow range wider" or "remove a lightness reversal"
 *     can't be expressed as a targeted edit; they're palette
 *     redesigns. So we offer named replacements whose lightness
 *     profile is GUARANTEED good — each candidate is verified using
 *     the rule's own analysis functions (see lightnessAdjust.ts).
 *
 *   Categorical:
 *     Most categorical palettes vary HUE rather than lightness, so
 *     scheme swaps almost never pass the per-pair ΔL* check. To
 *     avoid the "warning with no recommendations" UX, two genuine
 *     trade-offs cover this case:
 *
 *       Redistribute lightness (adjustment)
 *         Keeps the author's actual colours but spreads their L*
 *         values across a wide range. Same hues, same designer
 *         intent, legibly different in grayscale.
 *
 *       Switch to Okabe-Ito palette (replacement)
 *         Hand-picked palette with both CVD safety AND good L*
 *         separation. Drops the original colours entirely, but
 *         guarantees a strong default for accessibility.
 *
 *     Catalogue scheme swaps are also offered when any genuinely
 *     pass the safety check (rare at typical category counts), via
 *     the same per-rec verification mechanism the other shapes use.
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
import {setScheme, setRange, parentPointer} from './specMutators.js';
import {
  findLightnessSafeSchemes,
  redistributeLightness,
  OKABE_ITO_PALETTE,
} from './lightnessAdjust.js';
import type {SchemeType} from './schemeCatalog.js';

// ─── Evidence reader ─────────────────────────────────────────────

interface LightnessEvidence {
  scaleType: SchemeType;
  schemeName: string | null;
  /**
   * The colours actually rendered by the chart, threaded through by
   * the rule. For categorical issues these are the literal palette
   * the author chose (or the sliced scheme colours). For sequential
   * / diverging issues these are the sampled gradient. Only the
   * categorical-side recs (redistribute / Okabe-Ito) use them.
   */
  originalColors: string[];
}

function readLightnessEvidence(issue: AccessibilityIssue): LightnessEvidence | null {
  const e = issue.evidence as Record<string, unknown> | null | undefined;
  if (!e || typeof e !== 'object') return null;

  const scaleType = e.scaleType;
  if (
    scaleType !== 'categorical' &&
    scaleType !== 'sequential' &&
    scaleType !== 'diverging'
  ) {
    return null;
  }

  const schemeName = typeof e.schemeName === 'string' ? e.schemeName : null;
  const originalColorsRaw = e.originalColors;
  const originalColors = Array.isArray(originalColorsRaw)
    ? (originalColorsRaw as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];

  return {scaleType, schemeName, originalColors};
}

function isCategoricalIssue(ev: LightnessEvidence): boolean {
  return ev.scaleType === 'categorical';
}

// ─── Categorical: redistribute lightness ────────────────────────

/**
 * "Redistribute lightness in the current palette".
 *
 * The targeted-edit answer to the categorical case: take the
 * author's actual colours, keep each one's hue and chroma, and
 * spread their CIELAB L* values across a wide range so every pair
 * clears the rule's threshold. The minimum-disruption fix — same
 * palette identity, just spaced out.
 *
 * Drops out via `applicableWhen` only if the colours can't be parsed.
 */
export const redistributeLightnessRec: Recommendation = {
  id: 'lightness-redistribute',
  label: "Redistribute lightness across the palette",
  description:
    "Keeps your palette's hues and saturations but pushes the colours " +
    "apart in lightness, so they remain distinguishable in grayscale. " +
    "Each colour's identity is preserved — only how light or dark it " +
    "is changes. The most targeted fix, since the original colours are " +
    "kept in spirit.",
  family: 'adjustment',

  applicableWhen(issue) {
    const ev = readLightnessEvidence(issue);
    if (!ev) return false;
    if (!isCategoricalIssue(ev)) return false;
    if (ev.originalColors.length < 2) return false;
    // Try the redistribution; if any colour can't be parsed, bail.
    return redistributeLightness(ev.originalColors) != null;
  },

  apply(issue, spec) {
    const ev = readLightnessEvidence(issue);
    if (!ev) return spec;
    const redistributed = redistributeLightness(ev.originalColors);
    if (!redistributed) return spec;
    return setRange(spec, parentPointer(issue.jsonPointer), redistributed);
  },
};

// ─── Categorical: switch to Okabe-Ito ───────────────────────────

/**
 * "Switch to Okabe-Ito palette".
 *
 * The fallback for the categorical case: a hand-picked palette
 * (Okabe & Ito, 2008) designed for color vision deficiency that
 * also has well-distributed lightness. Sliced to the actual
 * category count so the spec is only as long as it needs to be.
 *
 * Same palette `colorblindSafetyRecs` offers for CVD failures, but
 * arrived at via a different correctness story: there it's the
 * de-facto CVD-safe standard; here it's "a palette guaranteed to
 * have good L* separation at any reasonable category count".
 */
export const switchToOkabeItoForLightness: Recommendation = {
  id: 'lightness-swap-to-okabe-ito',
  label: 'Switch to Okabe-Ito palette',
  description:
    'Replaces the current palette with the Okabe-Ito 8-colour scheme — ' +
    'hand-designed for color vision deficiency with well-separated ' +
    'lightness values across its colours. Strong default for ' +
    'accessibility, but drops your original palette entirely.',
  family: 'replacement',

  applicableWhen(issue) {
    const ev = readLightnessEvidence(issue);
    if (!ev) return false;
    if (!isCategoricalIssue(ev)) return false;
    // Don't offer if the data uses more categories than the palette has.
    return ev.originalColors.length > 0 &&
      ev.originalColors.length <= OKABE_ITO_PALETTE.length;
  },

  apply(issue, spec) {
    const ev = readLightnessEvidence(issue);
    if (!ev) return spec;
    const sliced = OKABE_ITO_PALETTE.slice(0, ev.originalColors.length);
    return setRange(spec, parentPointer(issue.jsonPointer), sliced);
  },
};

// ─── Sequential / diverging: catalogue scheme swaps ─────────────

/**
 * Build a "swap to {scheme}" recommendation for one specific safe
 * candidate. The applicableWhen verifies safety at apply-time
 * against the issue's actual scale type and category count, so a
 * generated rec only ever appears when it's genuinely a fix.
 */
function buildSchemeSwapRec(args: {
  schemeName: string;
  schemeType: SchemeType;
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
        categoryCount:
          args.schemeType === 'categorical' ? ev.originalColors.length : undefined,
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

const CANDIDATES: {name: string; type: SchemeType; description: string}[] = [
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

  // ── Categorical ──────────────────────────────────────────────
  // Included for completeness; rarely pass at typical category
  // counts, but the per-rec safety filter handles that correctly.
  {
    name: 'tableau10',
    type: 'categorical',
    description:
      "Tableau's standard categorical palette. May appear here when " +
      'sliced to a small number of categories where its lightness ' +
      'separation happens to be sufficient.',
  },
  {
    name: 'dark2',
    type: 'categorical',
    description:
      'Higher-saturation ColorBrewer categorical palette. As above — ' +
      'whether it passes depends on how many categories the data uses.',
  },
  {
    name: 'set2',
    type: 'categorical',
    description:
      'Muted ColorBrewer categorical palette. As above — whether it ' +
      'passes depends on the category count.',
  },
  {
    name: 'observable10',
    type: 'categorical',
    description:
      "Observable's default categorical palette. As above — whether it " +
      'passes depends on the category count.',
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
  // Categorical-specific: targeted (redistribute) and broad (Okabe-Ito)
  // both come first so they appear at the top of the categorical card.
  redistributeLightnessRec,
  switchToOkabeItoForLightness,
  // Catalogue scheme swaps for all three shapes — the safety filter
  // routes each candidate to the right issue.
  ...getSchemeSwapRecommendations(),
];