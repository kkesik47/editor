/**
 * recommendations/schemeCatalog.ts
 *
 * Curated metadata about Vega/D3 color schemes used by recommendations
 * to pick a CVD-safe replacement that preserves the "feel" of the
 * original palette (warm vs. cool, rainbow-like vs. monotonic, etc.).
 *
 * The catalog is intentionally small. We only list schemes we have
 * explicit guidance about. Schemes not in the catalog are treated as
 * "unknown" and fall back to a sensible default for the scale type.
 *
 * ─── On rainbow scales ──────────────────────────────────────────
 *
 * Rainbow scales have well-documented perceptual issues:
 *
 *   - Borland & Taylor II (2007), "Rainbow Color Map (Still)
 *     Considered Harmful", IEEE Computer Graphics & Applications.
 *   - Stauffer et al. (2015), "Rainbow color map distorts and
 *     misleads research in hydrology."
 *
 * However, recent work argues they retain communicative value in
 * specific contexts (high dynamic range, finely-resolved features):
 *
 *   - "Rainbow Colormaps Are Not All Bad" — the case that blanket
 *     rejection of rainbow scales is too strong.
 *
 * We resolve this tension by offering plural recommendations rather
 * than mandating viridis. When the author's original scale was
 * rainbow-like, we suggest TURBO — a perceptually improved rainbow
 * (Mikhailov, 2019) that preserves the high dynamic range while
 * being substantially safer under CVD. Authors who specifically
 * chose a rainbow keep what they wanted; authors who just defaulted
 * to one are nudged toward viridis through the description.
 */

export type SchemeType = 'categorical' | 'sequential' | 'diverging';

export type HueFamily =
  | 'rainbow-like' // turbo, rainbow, sinebow, spectral
  | 'cool'         // blues, greens, viridis
  | 'warm'         // reds, oranges, magma, inferno, plasma
  | 'neutral'      // greys, cividis
  | 'multi';       // categorical palettes with no single hue family

export interface SchemeEntry {
  /** Vega-Lite scheme name, lowercase. */
  name: string;
  type: SchemeType;
  hueFamily: HueFamily;
  cvdSafe: boolean;
  /** Short rationale, surfaced in recommendation descriptions where useful. */
  notes: string;
}

export const SCHEME_CATALOG: SchemeEntry[] = [
  // ─── Categorical CVD-safe schemes ─────────────────────────
  {
    name: 'tableau10',
    type: 'categorical',
    hueFamily: 'multi',
    cvdSafe: true,
    notes: 'Designed for categorical data with strong discriminability under CVD.',
  },
  {
    name: 'set2',
    type: 'categorical',
    hueFamily: 'multi',
    cvdSafe: true,
    notes: 'Muted ColorBrewer palette, good for non-vibrant designs.',
  },
  {
    name: 'dark2',
    type: 'categorical',
    hueFamily: 'multi',
    cvdSafe: true,
    notes: 'Higher-saturation ColorBrewer palette.',
  },
  {
    name: 'accent',
    type: 'categorical',
    hueFamily: 'multi',
    cvdSafe: true,
    notes: 'Pastel-leaning palette.',
  },
  {
    name: 'observable10',
    type: 'categorical',
    hueFamily: 'multi',
    cvdSafe: true,
    notes: "Observable's default categorical scheme.",
  },

  // ─── Sequential CVD-safe schemes ──────────────────────────
  {
    name: 'viridis',
    type: 'sequential',
    hueFamily: 'cool',
    cvdSafe: true,
    notes: 'Perceptually uniform, CVD-safe. Strong default for general sequential data.',
  },
  {
    name: 'cividis',
    type: 'sequential',
    hueFamily: 'neutral',
    cvdSafe: true,
    notes: 'Designed to look similar to CVD and non-CVD viewers.',
  },
  {
    name: 'magma',
    type: 'sequential',
    hueFamily: 'warm',
    cvdSafe: true,
    notes: 'Perceptually uniform with warm hue progression.',
  },
  {
    name: 'inferno',
    type: 'sequential',
    hueFamily: 'warm',
    cvdSafe: true,
    notes: 'Similar to magma with higher dynamic range.',
  },
  {
    name: 'plasma',
    type: 'sequential',
    hueFamily: 'warm',
    cvdSafe: true,
    notes: 'Perceptually uniform, magenta-to-yellow progression.',
  },
  {
    name: 'turbo',
    type: 'sequential',
    hueFamily: 'rainbow-like',
    cvdSafe: true,
    notes:
      'Perceptually improved rainbow. Preserves high dynamic range while ' +
      'being substantially safer under simulated CVD than classic rainbow.',
  },

  // ─── Diverging CVD-safer schemes ──────────────────────────
  {
    name: 'blueorange',
    type: 'diverging',
    hueFamily: 'multi',
    cvdSafe: true,
    notes: 'Uses the blue-orange axis, which is preserved under most CVD types.',
  },
  {
    name: 'redblue',
    type: 'diverging',
    hueFamily: 'multi',
    cvdSafe: true,
    notes: 'Classic diverging scheme; red-blue axis is reasonably CVD-safe.',
  },
  {
    name: 'purpleorange',
    type: 'diverging',
    hueFamily: 'multi',
    cvdSafe: true,
    notes: 'Purple-orange diverging scheme, good CVD safety.',
  },

  // ─── Schemes commonly used but problematic ────────────────
  {
    name: 'rainbow',
    type: 'sequential',
    hueFamily: 'rainbow-like',
    cvdSafe: false,
    notes: 'Classic rainbow; perceptually non-uniform and CVD-unsafe.',
  },
  {
    name: 'sinebow',
    type: 'sequential',
    hueFamily: 'rainbow-like',
    cvdSafe: false,
    notes: 'Sine-wave rainbow variant; same issues as classic rainbow.',
  },
  {
    name: 'spectral',
    type: 'diverging',
    hueFamily: 'rainbow-like',
    cvdSafe: false,
    notes: 'Rainbow-like diverging; CVD-unsafe across most types.',
  },
];

const DEFAULTS_BY_TYPE: Record<SchemeType, string> = {
  categorical: 'tableau10',
  sequential: 'viridis',
  diverging: 'blueorange',
};

/**
 * Look up a scheme by name. Case-insensitive; returns null if unknown.
 * Strips a trailing "-N" first (e.g. "blueorange-7" → "blueorange").
 */
export function findScheme(name: string): SchemeEntry | null {
  const lower = name.toLowerCase().replace(/-\d+$/, '');
  return SCHEME_CATALOG.find((s) => s.name === lower) ?? null;
}

/**
 * Pick a CVD-safe replacement scheme for the given original.
 *
 * Selection logic:
 *   1. Filter the catalog to safe schemes of the requested type.
 *   2. If the original is known and has a hue family, prefer a
 *      candidate with the same hue family. This is what makes
 *      "rainbow → turbo" happen automatically: both schemes share
 *      hueFamily 'rainbow-like'.
 *   3. Otherwise fall back to the default for that scale type.
 *
 * @param originalName  Name of the author's current scheme, if known.
 * @param scaleType     Target scale type for the replacement.
 */
export function pickReplacementScheme(
  originalName: string | null,
  scaleType: SchemeType,
): SchemeEntry {
  const original = originalName ? findScheme(originalName) : null;

  const candidates = SCHEME_CATALOG.filter(
    (s) => s.type === scaleType && s.cvdSafe,
  );

  if (candidates.length === 0) {
    throw new Error(`No CVD-safe schemes registered for type "${scaleType}"`);
  }

  // Prefer a candidate with the same hue family as the original.
  if (original) {
    const sameFamily = candidates.find((c) => c.hueFamily === original.hueFamily);
    if (sameFamily) return sameFamily;
  }

  // Otherwise return a sensible default.
  const defaultName = DEFAULTS_BY_TYPE[scaleType];
  return candidates.find((c) => c.name === defaultName) ?? candidates[0];
}