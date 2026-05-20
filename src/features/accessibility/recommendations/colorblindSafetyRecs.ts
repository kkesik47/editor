/**
 * recommendations/colorblindSafetyRecs.ts
 *
 * Recommendations for issues from `colorblindSafetyRule`.
 *
 * Design principle: PLURAL, NAMED REPLACEMENTS.
 *
 * Each recommendation targets a specific scheme rather than a generic
 * "switch to a CVD-safe palette". This is the conceptual contribution
 * of the recommendation engine: instead of the tool quietly picking a
 * replacement based on its own heuristics, the author sees every
 * applicable option side-by-side and makes the trade-off explicitly.
 *
 * For a sequential rainbow scale, the author sees BOTH:
 *   - Switch to viridis  (sacrifices the rainbow look entirely)
 *   - Switch to turbo    (preserves the rainbow look, still CVD-safe)
 * …and chooses based on whether they care about preserving rainbow.
 *
 * Recommendations are grouped by scale type. Within each group every
 * recommendation is a "replacement" family strategy. Future additions
 * (adjustment, redundancy, augmentation, restructure) will populate
 * the other families.
 *
 * Sequential schemes (5):
 *   - swapToViridis  (default; perceptually uniform, neutral default)
 *   - swapToCividis  (designed to look the same to CVD and non-CVD viewers)
 *   - swapToTurbo    (only when original is rainbow-like; preserves rainbow)
 *   - swapToMagma    (only when original is warm; preserves warm hue)
 *   - swapToPlasma   (only when original is warm; magenta-yellow progression)
 *
 * Categorical schemes (4):
 *   - swapToTableau10
 *   - swapToSet2
 *   - swapToDark2
 *   - swapToObservable10
 *
 * Diverging schemes (3):
 *   - swapToBlueOrange   (CVD-safest; uses CVD-preserved axis)
 *   - swapToRedBlue      (classic diverging)
 *   - swapToPurpleOrange (purple-orange diverging)
 *
 * Special case — rainbow-like diverging (spectral):
 *   `spectral` is classified as diverging by scheme name in
 *   `resolveScaleColors.ts`, but many authors who reach for spectral
 *   actually want a rainbow sequential, not a true diverging palette.
 *   So when the original is spectral, the SEQUENTIAL turbo/viridis
 *   recommendations are ALSO offered, giving the author a path away
 *   from spectral that doesn't force them into another diverging scheme.
 */

import type {AccessibilityIssue} from '../types.js';
import type {Recommendation} from './types.js';
import {setScheme, parentPointer} from './specMutators.js';
import {findScheme} from './schemeCatalog.js';

// ─── Shared evidence reader ─────────────────────────────────────

/**
 * The slice of `issue.evidence` we actually read here. Kept loose
 * because the rule produces a richer evidence object — we only
 * consume what recommendations need.
 */
interface CvdEvidence {
  scaleType: 'categorical' | 'sequential' | 'diverging';
  schemeName: string | null;
}

function readCvdEvidence(issue: AccessibilityIssue): CvdEvidence | null {
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
  return {scaleType, schemeName};
}

/**
 * Whether the original scheme reads as "rainbow-like" (rainbow,
 * sinebow, spectral). When true, we offer recommendations that
 * preserve the rainbow aesthetic (turbo) and also surface sequential
 * alternatives even when the spec is technically diverging.
 */
function isRainbowLikeOriginal(evidence: CvdEvidence): boolean {
  if (!evidence.schemeName) return false;
  const scheme = findScheme(evidence.schemeName);
  return scheme?.hueFamily === 'rainbow-like';
}

/**
 * Whether the original scheme reads as "warm" (reds/oranges palette).
 * Used to gate magma/plasma recommendations so they only appear when
 * the author was clearly going for a warm aesthetic.
 */
function isWarmOriginal(evidence: CvdEvidence): boolean {
  if (!evidence.schemeName) return false;
  const scheme = findScheme(evidence.schemeName);
  return scheme?.hueFamily === 'warm';
}

// ─── Helper factory ─────────────────────────────────────────────

/**
 * Build a "swap to a specific scheme" recommendation.
 *
 * All scheme-swap recommendations have the same shape — only the
 * target scheme, applicability rule, and description differ. The
 * factory removes the boilerplate.
 *
 * The `applies` callback receives the parsed CVD evidence and
 * returns whether this recommendation should appear for the issue.
 */
function buildSchemeSwap(args: {
  id: string;
  label: string;
  description: string;
  schemeName: string;
  applies: (evidence: CvdEvidence) => boolean;
}): Recommendation {
  return {
    id: args.id,
    label: args.label,
    description: args.description,
    family: 'replacement',

    applicableWhen(issue) {
      const evidence = readCvdEvidence(issue);
      if (!evidence) return false;
      // Don't recommend the scheme that's already in use.
      if (evidence.schemeName?.toLowerCase() === args.schemeName) return false;
      return args.applies(evidence);
    },

    apply(issue, spec) {
      return setScheme(spec, parentPointer(issue.jsonPointer), args.schemeName);
    },
  };
}

// ─── Sequential recommendations ─────────────────────────────────

export const swapToViridis = buildSchemeSwap({
  id: 'cvd-swap-to-viridis',
  label: 'Switch to viridis',
  description:
    'Perceptually uniform sequential palette, CVD-safe. Strong neutral ' +
    'default — sacrifices any specific hue feel for the most defensible ' +
    'accessibility profile.',
  schemeName: 'viridis',
  applies: (evidence) =>
    evidence.scaleType === 'sequential' ||
    // Spectral acts as a rainbow sequential for most authors,
    // so we also offer sequential alternatives.
    (evidence.scaleType === 'diverging' && isRainbowLikeOriginal(evidence)),
});

export const swapToCividis = buildSchemeSwap({
  id: 'cvd-swap-to-cividis',
  label: 'Switch to cividis',
  description:
    'Sequential palette designed so CVD and non-CVD viewers see ' +
    'nearly the same scale. Best when you want a single palette that ' +
    'works equivalently for all readers.',
  schemeName: 'cividis',
  applies: (evidence) =>
    evidence.scaleType === 'sequential' ||
    (evidence.scaleType === 'diverging' && isRainbowLikeOriginal(evidence)),
});

export const swapToTurbo = buildSchemeSwap({
  id: 'cvd-swap-to-turbo',
  label: 'Switch to turbo',
  description:
    'CVD improved rainbow. Preserves the rainbow look and ' +
    'high dynamic range while being substantially safer under simulated ' +
    'color vision deficiencies than classic rainbow.',
  schemeName: 'turbo',
  applies: (evidence) =>
    // Sequential context: only offered when the original was rainbow-like.
    // (For non-rainbow sequentials, viridis/cividis are better defaults.)
    (evidence.scaleType === 'sequential' && isRainbowLikeOriginal(evidence)) ||
    // Diverging spectral: same reasoning — most spectral users want
    // a rainbow sequential, and turbo is the rainbow sequential.
    (evidence.scaleType === 'diverging' && isRainbowLikeOriginal(evidence)),
});

export const swapToMagma = buildSchemeSwap({
  id: 'cvd-swap-to-magma',
  label: 'Switch to magma',
  description:
    'Perceptually uniform sequential palette with a warm hue progression ' +
    '(dark purple → orange → yellow). Best when the original palette was ' +
    'warm and you want to preserve that feel.',
  schemeName: 'magma',
  applies: (evidence) =>
    evidence.scaleType === 'sequential' && isWarmOriginal(evidence),
});

export const swapToPlasma = buildSchemeSwap({
  id: 'cvd-swap-to-plasma',
  label: 'Switch to plasma',
  description:
    'Perceptually uniform sequential palette with a magenta-to-yellow ' +
    'progression. Higher dynamic range than magma; good for warm palettes ' +
    'where contrast at the bright end matters.',
  schemeName: 'plasma',
  applies: (evidence) =>
    evidence.scaleType === 'sequential' && isWarmOriginal(evidence),
});

// ─── Categorical recommendations ────────────────────────────────

export const swapToTableau10 = buildSchemeSwap({
  id: 'cvd-swap-to-tableau10',
  label: 'Switch to tableau10',
  description:
    'Tableau\'s standard categorical palette. Designed for strong ' +
    'discriminability under simulated color vision deficiencies. ' +
    'Good neutral default for most categorical encodings.',
  schemeName: 'tableau10',
  applies: (evidence) => evidence.scaleType === 'categorical',
});

export const swapToSet2 = buildSchemeSwap({
  id: 'cvd-swap-to-set2',
  label: 'Switch to set2',
  description:
    'Muted ColorBrewer categorical palette. Best when the original ' +
    'design was non-vibrant and a softer palette fits the visual tone.',
  schemeName: 'set2',
  applies: (evidence) => evidence.scaleType === 'categorical',
});

export const swapToDark2 = buildSchemeSwap({
  id: 'cvd-swap-to-dark2',
  label: 'Switch to dark2',
  description:
    'Higher-saturation ColorBrewer categorical palette. Best when the ' +
    'original design was vibrant and you want to keep strong color ' +
    'separation between categories.',
  schemeName: 'dark2',
  applies: (evidence) => evidence.scaleType === 'categorical',
});

export const swapToObservable10 = buildSchemeSwap({
  id: 'cvd-swap-to-observable10',
  label: 'Switch to observable10',
  description:
    "Observable's default categorical palette. Modern, well-balanced " +
    'between vibrancy and discriminability under CVD.',
  schemeName: 'observable10',
  applies: (evidence) => evidence.scaleType === 'categorical',
});

// ─── Diverging recommendations ──────────────────────────────────

export const swapToBlueOrange = buildSchemeSwap({
  id: 'cvd-swap-to-blueorange',
  label: 'Switch to blueorange',
  description:
    'Diverging palette on the blue-orange axis, which is preserved ' +
    'under most types of color vision deficiency. The safest diverging ' +
    'default for CVD users.',
  schemeName: 'blueorange',
  applies: (evidence) => evidence.scaleType === 'diverging',
});

export const swapToRedBlue = buildSchemeSwap({
  id: 'cvd-swap-to-redblue',
  label: 'Switch to redblue',
  description:
    'Classic diverging palette (red-white-blue). Reasonably CVD-safe — ' +
    'the red and blue ends remain distinguishable for protanopia and ' +
    'deuteranopia, though weaker for tritanopia than blue-orange.',
  schemeName: 'redblue',
  applies: (evidence) => evidence.scaleType === 'diverging',
});

export const swapToPurpleOrange = buildSchemeSwap({
  id: 'cvd-swap-to-purpleorange',
  label: 'Switch to purpleorange',
  description:
    'Diverging palette on the purple-orange axis. Useful when red-blue ' +
    'or blue-orange clash with surrounding design; the purple end gives ' +
    'a distinct visual identity while staying CVD-safer than spectral.',
  schemeName: 'purpleorange',
  applies: (evidence) => evidence.scaleType === 'diverging',
});

// ─── Registry ────────────────────────────────────────────────────

/**
 * All recommendations for colorblindSafetyRule, in display order.
 *
 * Ordering rationale:
 *   - Sequential safe defaults (viridis, cividis) come first because
 *     they are the most defensible recommendations regardless of context.
 *   - Context-specific sequential options (turbo, magma, plasma) come
 *     next; their `applicableWhen` filters keep them out when irrelevant.
 *   - Categorical options come next, ordered from most-neutral
 *     (tableau10) to most-niche (observable10).
 *   - Diverging options come last, ordered from CVD-safest (blueorange)
 *     to most-specific (purpleorange).
 *
 * The UI filters by `applicableWhen` before rendering, so on any given
 * issue only the relevant subset appears — typically 2–4 options.
 */
export const colorblindSafetyRecommendations: Recommendation[] = [
  // Sequential
  swapToTurbo,
  swapToViridis,
  swapToCividis,
  swapToMagma,
  swapToPlasma,
  // Categorical
  swapToTableau10,
  swapToSet2,
  swapToDark2,
  swapToObservable10,
  // Diverging
  swapToBlueOrange,
  swapToRedBlue,
  swapToPurpleOrange,
];

// ─── Backward-compatibility shim ────────────────────────────────

/**
 * Backward-compatibility shim for the v1 API.
 *
 * Earlier versions of this module exported `describeCvdRecommendation`
 * to dynamically produce per-issue descriptions ("Switches 'rainbow' to
 * 'turbo'…"). The new design bakes the description into each named
 * recommendation directly, so dynamic rewriting is no longer needed.
 *
 * This shim is kept so that:
 *   - `index.ts` can continue re-exporting the same name, and
 *   - any UI code that still calls `describeCvdRecommendation(rec, issue)`
 *     keeps working without modification.
 *
 * It simply returns the recommendation's static description.
 */
export function describeCvdRecommendation(
  recommendation: Recommendation,
  _issue: AccessibilityIssue,
): string {
  return recommendation.description;
}