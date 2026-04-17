/**
 * perceptualUniformityAnalysis.ts
 *
 * Measures whether a sequential color scale has perceptually uniform
 * steps — i.e., equal data intervals produce equal perceived color
 * changes.
 *
 * The classic failure case is the rainbow colormap, where some
 * regions (yellow-green) barely seem to change while others
 * (blue-cyan) jump dramatically. This creates false visual
 * boundaries and hides real gradients, misleading readers.
 *
 * Method:
 *   1. Sample the scale at evenly-spaced intervals (already done
 *      by resolveScaleColors — typically 16 samples).
 *   2. Compute CIEDE2000 ΔE between each consecutive pair.
 *      This gives N-1 "step sizes" that capture perceived
 *      color change in hue, chroma, and lightness together.
 *   3. Measure step evenness using two metrics:
 *
 *      Coefficient of Variation (CV) = stdDev / mean
 *        Low CV → uniform steps → good.
 *        High CV → wildly uneven steps → problematic.
 *
 *      Max/Min ratio = largest step / smallest step
 *        Catches localized problems (one huge jump next to
 *        a flat region) that a global CV might average away.
 *
 * Why CIEDE2000 and not just lightness?
 *   A scale could have perfectly monotonic lightness but still
 *   have non-uniform perceptual steps because hue shifts unevenly.
 *   CIEDE2000 captures the full perceptual picture.
 *
 * References:
 *   Borland & Taylor (2007), "Rainbow Color Map (Still) Harmful"
 *   Crameri, Shephard & Heron (2020), "Misuse of colour in science"
 */

import {parse, differenceCiede2000} from 'culori';

// ─── Constants ───────────────────────────────────────────────────

/**
 * CV below this → uniform enough, no issue.
 * Typical values: viridis ~0.1, blues ~0.2.
 */
export const CV_OK_THRESHOLD = 0.3;

/**
 * CV between OK and WARNING → moderately uneven (info).
 * Typical values: some diverging schemes ~0.35.
 */
export const CV_WARNING_THRESHOLD = 0.5;

/**
 * Max/min step ratio above this → localized jump (warning).
 * A ratio of 4 means one step "looks" 4× bigger than another.
 */
export const MAX_MIN_RATIO_THRESHOLD = 4;

/**
 * Minimum number of colors needed for meaningful analysis.
 * With fewer than 5 colors, CV is unreliable.
 */
export const MIN_COLORS_FOR_ANALYSIS = 5;

// ─── Types ───────────────────────────────────────────────────────

/** One step between consecutive colors. */
export interface PerceptualStep {
  /** Index of the first color (0-based). */
  indexA: number;
  /** Index of the second color (0-based). */
  indexB: number;
  /** CSS color string of the first color. */
  colorA: string;
  /** CSS color string of the second color. */
  colorB: string;
  /** CIEDE2000 ΔE between the two colors. */
  deltaE: number;
}

/** Full result of the uniformity analysis. */
export interface UniformityAnalysisResult {
  /** CIEDE2000 ΔE for each consecutive pair. */
  steps: PerceptualStep[];
  /** Mean ΔE across all steps. */
  mean: number;
  /** Standard deviation of ΔE across steps. */
  stdDev: number;
  /** Coefficient of variation (stdDev / mean). */
  cv: number;
  /** Largest ΔE step. */
  maxStep: number;
  /** Smallest ΔE step. */
  minStep: number;
  /** Ratio of largest to smallest step. */
  maxMinRatio: number;
  /** Whether there are enough colors to analyze. */
  hasSufficientColors: boolean;
}

// ─── Core logic ──────────────────────────────────────────────────

const computeDeltaE = differenceCiede2000();

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Analyze the perceptual uniformity of a color scale.
 *
 * Computes CIEDE2000 ΔE between each consecutive pair and
 * measures how evenly distributed the steps are.
 *
 * @param colors - Array of CSS color strings (sequential order).
 * @returns Analysis result with step values and evenness metrics.
 */
export function analyzePerceptualUniformity(
  colors: string[],
): UniformityAnalysisResult {
  // Not enough colors for meaningful analysis
  if (colors.length < MIN_COLORS_FOR_ANALYSIS) {
    return {
      steps: [],
      mean: 0,
      stdDev: 0,
      cv: 0,
      maxStep: 0,
      minStep: 0,
      maxMinRatio: 1,
      hasSufficientColors: false,
    };
  }

  // Parse all colors once
  const parsed = colors.map((c) => parse(c));

  // Compute ΔE between each consecutive pair
  const steps: PerceptualStep[] = [];

  for (let i = 0; i < colors.length - 1; i++) {
    const a = parsed[i];
    const b = parsed[i + 1];

    // Skip pairs where either color failed to parse
    if (!a || !b) continue;

    const deltaE = computeDeltaE(a, b);

    steps.push({
      indexA: i,
      indexB: i + 1,
      colorA: colors[i],
      colorB: colors[i + 1],
      deltaE: round2(deltaE),
    });
  }

  // Need at least 2 steps for meaningful statistics
  if (steps.length < 2) {
    return {
      steps,
      mean: steps.length === 1 ? steps[0].deltaE : 0,
      stdDev: 0,
      cv: 0,
      maxStep: steps.length === 1 ? steps[0].deltaE : 0,
      minStep: steps.length === 1 ? steps[0].deltaE : 0,
      maxMinRatio: 1,
      hasSufficientColors: false,
    };
  }

  // Compute statistics
  const deltaEs = steps.map((s) => s.deltaE);
  const mean = round2(deltaEs.reduce((sum, d) => sum + d, 0) / deltaEs.length);

  const variance =
    deltaEs.reduce((sum, d) => sum + (d - mean) ** 2, 0) / deltaEs.length;
  const stdDev = round2(Math.sqrt(variance));

  const cv = mean > 0 ? round2(stdDev / mean) : 0;

  const maxStep = round2(Math.max(...deltaEs));
  const minStep = round2(Math.min(...deltaEs));
  const maxMinRatio = minStep > 0 ? round2(maxStep / minStep) : Infinity;

  return {
    steps,
    mean,
    stdDev,
    cv,
    maxStep,
    minStep,
    maxMinRatio,
    hasSufficientColors: true,
  };
}