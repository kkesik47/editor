/**
 * recommendations/contrastAdjust.ts
 *
 * Shared math for the contrast recommendations.
 *
 * Three operations live here, none of which fits the pure-mutator
 * philosophy of `specMutators.ts` (they compute new COLORS, not new
 * spec edits):
 *
 *   1. adjustForegroundUntilRatio
 *      Given a foreground and background, return a foreground colour
 *      adjusted just enough to clear a target contrast ratio. Used
 *      by "Darken/lighten foreground" and "Darken/lighten the mark".
 *
 *   2. pickSafeBackgroundFor
 *      Given a set of failing foreground colours, return the
 *      background extreme (white or near-black) that maximises the
 *      MINIMUM contrast ratio across them. Used by "Change
 *      background". This is the corrected picker - earlier versions
 *      snapped based on the current background's theme, which got
 *      dark-on-dark cases exactly backwards.
 *
 *   3. findContrastSafeSchemes
 *      Walk the scheme catalog, resolve each scheme at an appropriate
 *      sample density, and return the schemes where every sampled
 *      colour clears a target ratio against the given background.
 *      Used by the palette-swap recommendation for scale failures.
 *
 * All three reuse `computeContrastRatio` from `contrastAnalysis.ts`,
 * so the math stays consistent with how the rule itself measures.
 */

import {parse, converter, formatHex} from 'culori';
import {scheme as vegaScheme} from 'vega-scale';
import {computeContrastRatio} from '../rules/contrastAnalysis.js';
import {SCHEME_CATALOG, type SchemeType, type SchemeEntry} from './schemeCatalog.js';

// ─── Background snap targets ─────────────────────────────────────
//
// "Change background" snaps to a safe extreme rather than computing a
// minimal nudge: a global colour change is more likely to introduce
// new failures elsewhere than fix them, so half-measures are
// dangerous. Pure white and a deep near-black are the defensible
// extremes; one of them will help any failing foreground.

export const LIGHT_BG_TARGET = '#ffffff';
export const DARK_BG_TARGET = '#111111';

// ─── Foreground nudge ───────────────────────────────────────────

/**
 * Margin above the target ratio at which we stop iterating.
 *
 * `computeContrastRatio` rounds to 2 decimals, so stopping at exactly
 * the threshold could leave us at e.g. 4.5 displayed but 4.498
 * actual, and the rule would refire. The margin keeps the result
 * comfortably above the line without overshooting the original color
 * by a noticeable amount.
 */
const RATIO_MARGIN = 0.1;

/** Step size, in OKLCH L units, used while searching. */
const L_STEP = 0.02;

/** Safety cap on the number of steps - guards against runaway loops. */
const MAX_STEPS = 60;

const toOklch = converter('oklch');

/**
 * Decide whether to push lightness up or down to gain contrast
 * against the given background.
 *
 * Earlier this was decided by `isLightBackground(bg)`, but that's
 * subtly wrong for mid-tone backgrounds: it asks "is the background
 * light?" when the real question is "is the foreground darker or
 * lighter than the background?". For a near-mid-gray background and
 * a slightly-darker foreground, the previous heuristic could push
 * the foreground toward the background instead of away from it.
 *
 * We now compare luminances directly and push the foreground further
 * from the background's luminance. Ties go down (treat as dark fg).
 */
function nudgeDirection(fg: string, bg: string): -1 | 1 {
  const fgParsed = parse(fg);
  const bgParsed = parse(bg);
  if (!fgParsed || !bgParsed) return -1;
  const fgL = toOklch(fgParsed)?.l ?? 0;
  const bgL = toOklch(bgParsed)?.l ?? 0;
  // If fg is darker → go darker still. If lighter → go lighter still.
  return fgL <= bgL ? -1 : +1;
}

/**
 * Adjust a foreground color along the OKLCH lightness axis until its
 * contrast ratio against the given background reaches `targetRatio`
 * (plus a small margin). Hue and chroma are preserved, so the color's
 * identity is kept as much as possible - only its lightness changes.
 *
 * OKLCH (Björn Ottosson, 2020) is used rather than CIELAB because
 * its lightness axis is more perceptually uniform for hue-preserving
 * lightness changes - exactly the operation we want here.
 *
 * Returns null in degenerate cases:
 *   - foreground or background cannot be parsed
 *   - the search hits L = 0 or L = 1 and still doesn't clear the
 *     target (e.g. foreground was already near pure black/white
 *     against a similarly-toned background - no nudge can save it,
 *     the user needs a different rec).
 */
export function adjustForegroundUntilRatio(foreground: string, background: string, targetRatio: number): string | null {
  const parsed = parse(foreground);
  if (!parsed) return null;

  const oklch = toOklch(parsed);
  if (!oklch) return null;

  const direction = nudgeDirection(foreground, background);

  let l = oklch.l;
  const target = targetRatio + RATIO_MARGIN;

  for (let step = 0; step < MAX_STEPS; step++) {
    // Clamp to [0, 1]. Hitting the boundary without clearing target
    // is the degenerate case - bail out and let the caller offer a
    // different rec (e.g. "Use black/white text" or "Change background").
    if (l <= 0 || l >= 1) {
      const clamped = {...oklch, l: Math.max(0, Math.min(1, l))};
      const hex = formatHex(clamped);
      if (!hex) return null;
      const finalRatio = computeContrastRatio(hex, background);
      return finalRatio != null && finalRatio >= target ? hex : null;
    }

    const candidate = {...oklch, l};
    const hex = formatHex(candidate);
    if (!hex) return null;

    const ratio = computeContrastRatio(hex, background);
    if (ratio != null && ratio >= target) {
      return hex;
    }

    l += direction * L_STEP;
  }

  return null;
}

// ─── Safe-background picker ─────────────────────────────────────

/**
 * Pick the background extreme (white or near-black) that maximises
 * the MINIMUM contrast ratio across the given failing foregrounds.
 *
 * This is the corrected picker. Earlier versions chose based on the
 * current background's theme (`isLightBackground(currentBg)`), which
 * silently broke dark-on-dark cases: a near-black scale on a black
 * background would snap to near-black, lowering contrast further.
 *
 * The right question is "where do the failing foregrounds sit?", not
 * "what theme is the chart in?". Near-black failing colours need a
 * LIGHT extreme, regardless of where the current background is.
 *
 * Strategy: try both extremes, pick whichever gives the higher worst-
 * case ratio against the failing set. Ties go to white (the more
 * common default).
 *
 * Returns null only when none of the failing colours parse - at
 * which point we have nothing sensible to optimise against.
 */
export function pickSafeBackgroundFor(failingForegrounds: string[]): string | null {
  if (failingForegrounds.length === 0) return null;

  const minRatioAgainst = (bg: string): number => {
    let worst = Infinity;
    for (const fg of failingForegrounds) {
      const r = computeContrastRatio(fg, bg);
      if (r == null) continue;
      if (r < worst) worst = r;
    }
    return worst === Infinity ? -Infinity : worst;
  };

  const whiteScore = minRatioAgainst(LIGHT_BG_TARGET);
  const darkScore = minRatioAgainst(DARK_BG_TARGET);

  if (whiteScore === -Infinity && darkScore === -Infinity) return null;
  return whiteScore >= darkScore ? LIGHT_BG_TARGET : DARK_BG_TARGET;
}

/**
 * Pick the pure text colour (black or white) that contrasts best with
 * the given background. Direct and obvious: compare black-on-bg vs
 * white-on-bg and take the winner.
 *
 * (An earlier version routed this through pickSafeBackgroundFor and
 * inverted the result - white text on light backgrounds, black on
 * dark. This is the corrected, self-evident form.)
 */
export function pickTextColorFor(bg: string): '#000000' | '#ffffff' {
  const blackRatio = computeContrastRatio('#000000', bg) ?? 0;
  const whiteRatio = computeContrastRatio('#ffffff', bg) ?? 0;
  return blackRatio >= whiteRatio ? '#000000' : '#ffffff';
}

// ─── Scheme contrast-safety check ───────────────────────────────

/**
 * How many samples to draw from a continuous (sequential / diverging)
 * scheme to check its contrast safety. Matches the density used by
 * `resolveScaleColors`, so the check matches what the rule sees.
 */
const CONTINUOUS_SAMPLE_COUNT = 16;

/**
 * Resolve a Vega-registered scheme to a concrete color array.
 *
 * Mirrors the relevant bits of `resolveScaleColors.ts` but kept local
 * to avoid coupling the recommendations module to that file's
 * internal helpers. For categorical schemes we slice to the actual
 * category count (so a 3-category chart is checked against the first
 * 3 colors of tableau10, not all 10).
 *
 * Returns null when the scheme can't be resolved - those candidates
 * just drop out of the safety scan.
 */
function resolveSchemeColors(schemeName: string, scaleType: SchemeType, categoryCount?: number): string[] | null {
  let value: unknown;
  try {
    value = vegaScheme(schemeName);
  } catch {
    return null;
  }
  if (!value) return null;

  // Continuous interpolator → sample evenly.
  if (typeof value === 'function') {
    const n = CONTINUOUS_SAMPLE_COUNT;
    const samples: string[] = [];
    for (let i = 0; i < n; i++) {
      samples.push((value as (t: number) => string)(i / (n - 1)));
    }
    return samples;
  }

  // Discrete categorical scheme → array of strings, slice if we know
  // how many categories the data actually uses.
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
    const colors = value as string[];
    return categoryCount && categoryCount > 0 ? colors.slice(0, categoryCount) : colors;
  }

  return null;
}

/** Whether every colour in `colors` clears `targetRatio` against `bg`. */
function allColorsClearRatio(colors: string[], bg: string, targetRatio: number): boolean {
  for (const c of colors) {
    const ratio = computeContrastRatio(c, bg);
    if (ratio == null || ratio < targetRatio) return false;
  }
  return true;
}

/**
 * Find Vega-registered schemes whose colors all clear `targetRatio`
 * against the given background.
 *
 * Used by the "Switch to a contrast-safe palette" recommendation for
 * scale-contrast failures: it offers the author a real alternative
 * that is *guaranteed* to pass, not a vibes-based recommendation.
 *
 * Only schemes matching the requested scale type are considered, and
 * the original scheme (if any) is excluded so we never offer the same
 * one back. Categorical schemes are sliced to `categoryCount` before
 * checking, so the result is honest for the chart's actual data.
 *
 * Returns an empty array when no candidate scheme passes - at which
 * point the caller's `applicableWhen` should drop the recommendation
 * entirely (the user keeps the background-change option, which is the
 * other way out of a scale-contrast failure).
 */
export function findContrastSafeSchemes(args: {
  background: string;
  scaleType: SchemeType;
  targetRatio: number;
  /** Number of categories the data actually uses (categorical only). */
  categoryCount?: number;
  /** Original scheme name to exclude from the result, if any. */
  excludeSchemeName?: string | null;
}): SchemeEntry[] {
  const exclude = args.excludeSchemeName?.toLowerCase().replace(/-\d+$/, '');

  const candidates = SCHEME_CATALOG.filter((s) => s.type === args.scaleType && s.name !== exclude);

  const safe: SchemeEntry[] = [];
  for (const candidate of candidates) {
    const colors = resolveSchemeColors(candidate.name, args.scaleType, args.categoryCount);
    if (!colors || colors.length === 0) continue;
    if (allColorsClearRatio(colors, args.background, args.targetRatio)) {
      safe.push(candidate);
    }
  }
  return safe;
}
