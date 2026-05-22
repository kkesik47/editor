/**
 * recommendations/colorblindSafetyRecs.ts
 *
 * Recommendations for issues from `colorblindSafetyRule`.
 *
 * Design principle: PLURAL, NAMED REPLACEMENTS.
 *
 * Each recommendation targets a specific palette rather than a generic
 * "switch to a CVD-safe palette". The author sees every applicable
 * option side-by-side and makes the trade-off explicitly, instead of
 * the tool quietly picking a replacement based on its own heuristics.
 *
 * Recommendations are grouped by scale type. Within each group every
 * recommendation is a "replacement" family strategy.
 *
 * Sequential schemes (5):
 *   - swapToViridis  (default; perceptually uniform, neutral)
 *   - swapToCividis  (designed to look the same to CVD and non-CVD viewers)
 *   - swapToTurbo    (only when original is rainbow-like; preserves rainbow)
 *   - swapToMagma    (only when original is warm; preserves warm hue)
 *   - swapToPlasma   (only when original is warm; magenta-yellow progression)
 *
 * Categorical schemes / palettes (6):
 *   - Vega-registered schemes (set via scale.scheme):
 *     swapToTableau10, swapToSet2, swapToDark2, swapToObservable10
 *   - Hand-picked, guaranteed-safe palettes (set via scale.range):
 *     swapToOkabeIto  — the de-facto CVD-safe standard (8 colors)
 *     swapToWong      — Nature Methods recommendation (7 colors)
 *
 *   The hand-picked palettes are added so that authors with small
 *   categorical scales (2–8 categories) get a guaranteed-safe option
 *   even when the standard schemes have problematic far-pair confusions
 *   that don't affect their visualization at the current category count.
 *
 * Diverging schemes (3):
 *   - swapToBlueOrange, swapToRedBlue, swapToPurpleOrange
 */

import type {AccessibilityIssue} from '../types.js';
import type {Recommendation, VegaLiteSpec} from './types.js';
import {setScheme, setRange, parentPointer} from './specMutators.js';
import {findScheme} from './schemeCatalog.js';

// ─── Shared evidence reader ─────────────────────────────────────

interface CvdEvidence {
  scaleType: 'categorical' | 'sequential' | 'diverging';
  schemeName: string | null;
  /** Optional: how many categories the data actually uses. */
  usedCategoryCount: number | null;
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
  const usedCategoryCount =
    typeof e.usedCategoryCount === 'number' ? e.usedCategoryCount : null;
  return {scaleType, schemeName, usedCategoryCount};
}

function isRainbowLikeOriginal(evidence: CvdEvidence): boolean {
  if (!evidence.schemeName) return false;
  const scheme = findScheme(evidence.schemeName);
  return scheme?.hueFamily === 'rainbow-like';
}

function isWarmOriginal(evidence: CvdEvidence): boolean {
  if (!evidence.schemeName) return false;
  const scheme = findScheme(evidence.schemeName);
  return scheme?.hueFamily === 'warm';
}

// ─── Hand-picked CVD-safe palettes ──────────────────────────────

/**
 * Okabe & Ito (2008) categorical palette.
 *
 * Designed specifically for color vision deficiency, this palette has
 * become the de-facto standard for CVD-safe categorical encoding in
 * scientific visualization. Eight colors, every pair distinguishable
 * under protanopia, deuteranopia, and tritanopia.
 *
 * Reference: Okabe, M. & Ito, K. (2008). "Color Universal Design (CUD)".
 *   https://jfly.uni-koeln.de/color/
 */
const OKABE_ITO: string[] = [
  '#000000', // black
  '#E69F00', // orange
  '#56B4E9', // sky blue
  '#009E73', // bluish green
  '#F0E442', // yellow
  '#0072B2', // blue
  '#D55E00', // vermillion
  '#CC79A7', // reddish purple
];

/**
 * Wong (2011) categorical palette (Nature Methods).
 *
 * Seven-color palette from the influential Nature Methods column
 * "Points of view: Color blindness". Slightly more muted than
 * Okabe-Ito but with the same CVD-safety guarantees.
 *
 * Reference: Wong, B. (2011). "Color blindness". Nature Methods 8, 441.
 *   https://doi.org/10.1038/nmeth.1618
 */
const WONG: string[] = [
  '#000000', // black
  '#E69F00', // orange
  '#56B4E9', // sky blue
  '#009E73', // bluish green
  '#F0E442', // yellow
  '#0072B2', // blue
  '#D55E00', // vermillion
];

// ─── Helper factories ───────────────────────────────────────────

/**
 * Build a "swap to a Vega-registered scheme" recommendation.
 *
 * Used for schemes like viridis, tableau10 — anything in Vega's
 * scheme registry that can be referenced by `scale.scheme: "name"`.
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
      if (evidence.schemeName?.toLowerCase() === args.schemeName) return false;
      return args.applies(evidence);
    },

    apply(issue, spec) {
      return setScheme(spec, parentPointer(issue.jsonPointer), args.schemeName);
    },
  };
}

/**
 * Build a "swap to an explicit range" recommendation.
 *
 * Used for hand-picked palettes (Okabe-Ito, Wong) that aren't
 * registered as Vega schemes and have to be applied as an explicit
 * `scale.range` array.
 *
 * The palette is sliced to the actual category count when available,
 * so a 3-category chart gets the first 3 Okabe-Ito colors, not all 8.
 * This keeps the spec tidy and avoids dropping unused colors into the
 * user's source.
 */
function buildRangeSwap(args: {
  id: string;
  label: string;
  description: string;
  palette: string[];
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
      // Don't offer a palette that has fewer colors than the data needs.
      if (
        evidence.usedCategoryCount != null &&
        evidence.usedCategoryCount > args.palette.length
      ) {
        return false;
      }
      return args.applies(evidence);
    },

    apply(issue, spec) {
      const evidence = readCvdEvidence(issue);
      const count = evidence?.usedCategoryCount ?? args.palette.length;
      const slice = args.palette.slice(0, count);
      return setRange(spec, parentPointer(issue.jsonPointer), slice);
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
  applies: (evidence) => evidence.scaleType === 'sequential',
});

export const swapToCividis = buildSchemeSwap({
  id: 'cvd-swap-to-cividis',
  label: 'Switch to cividis',
  description:
    'Sequential palette designed so CVD and non-CVD viewers see ' +
    'nearly the same scale. Best when you want a single palette that ' +
    'works equivalently for all readers.',
  schemeName: 'cividis',
  applies: (evidence) => evidence.scaleType === 'sequential',
});

export const swapToTurbo = buildSchemeSwap({
  id: 'cvd-swap-to-turbo',
  label: 'Switch to turbo',
  description:
    'Perceptually improved rainbow. Preserves the rainbow look and ' +
    'high dynamic range while being substantially safer under simulated ' +
    'color vision deficiencies than classic rainbow.',
  schemeName: 'turbo',
  applies: (evidence) =>
    evidence.scaleType === 'sequential' && isRainbowLikeOriginal(evidence),
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
    "Tableau's standard categorical palette. Designed for strong " +
    'discriminability under simulated color vision deficiencies. ' +
    'Good neutral default for most categorical encodings.',
  schemeName: 'tableau10',
  applies: (evidence) => evidence.scaleType === 'categorical',
});

/**
 * Maximum number of categories at which set2 stays CVD-safe.
 *
 * set2 is a muted ColorBrewer palette that is safe at low category
 * counts but develops a protanopia-confusable pair once five or more
 * of its colours are in play. We only offer it when the data uses few
 * enough categories that it won't simply re-trigger the same warning.
 * Past this count, the guaranteed-safe palettes (Okabe-Ito, Wong) and
 * the more robust schemes (tableau10, dark2, observable10) are better
 * recommendations.
 */
const SET2_SAFE_CATEGORY_LIMIT = 4;

export const swapToSet2 = buildSchemeSwap({
  id: 'cvd-swap-to-set2',
  label: 'Switch to set2',
  description:
    'Muted ColorBrewer categorical palette, CVD-safe up to about four ' +
    'categories. Best when the original design was non-vibrant and a ' +
    'softer palette fits the visual tone.',
  schemeName: 'set2',
  applies: (evidence) =>
    evidence.scaleType === 'categorical' &&
    // Only offer set2 when we know the count is small enough for it to
    // be safe. When the count is unknown (e.g. data from a URL), we err
    // on the side of NOT recommending it, since it would often re-fail.
    evidence.usedCategoryCount != null &&
    evidence.usedCategoryCount <= SET2_SAFE_CATEGORY_LIMIT,
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

export const swapToOkabeIto = buildRangeSwap({
  id: 'cvd-swap-to-okabe-ito',
  label: 'Switch to Okabe-Ito',
  description:
    'Hand-picked 8-colour palette designed specifically for color ' +
    'vision deficiency (Okabe & Ito, 2008). The de-facto standard for ' +
    'CVD-safe categorical visualization in scientific publications.',
  palette: OKABE_ITO,
  applies: (evidence) => evidence.scaleType === 'categorical',
});

export const swapToWong = buildRangeSwap({
  id: 'cvd-swap-to-wong',
  label: 'Switch to Wong palette',
  description:
    'Hand-picked 7-colour palette from Nature Methods (Wong, 2011). ' +
    'Slightly more muted than Okabe-Ito with the same CVD-safety ' +
    'guarantees. Good for academic / publication-style figures.',
  palette: WONG,
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

export const colorblindSafetyRecommendations: Recommendation[] = [
  // Sequential
  swapToViridis,
  swapToCividis,
  swapToTurbo,
  swapToMagma,
  swapToPlasma,
  // Categorical — Vega-registered schemes first
  swapToTableau10,
  swapToSet2,
  swapToDark2,
  swapToObservable10,
  // Categorical — hand-picked, guaranteed-safe palettes
  swapToOkabeIto,
  swapToWong,
  // Diverging
  swapToBlueOrange,
  swapToRedBlue,
  swapToPurpleOrange,
];

// ─── Backward-compatibility shim ────────────────────────────────

/**
 * Backward-compatibility shim for the v1 API. Returns the
 * recommendation's static description.
 */
export function describeCvdRecommendation(
  recommendation: Recommendation,
  _issue: AccessibilityIssue,
): string {
  return recommendation.description;
}