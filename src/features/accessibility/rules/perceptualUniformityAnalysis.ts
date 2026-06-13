/**
 * perceptualUniformityAnalysis.ts
 *
 * Measures whether an ordered color scale has perceptually uniform
 * steps - i.e., equal data intervals produce equal perceived color
 * changes.
 *
 * The classic failure case is the rainbow colormap, where some
 * regions (yellow-green) barely seem to change while others
 * (blue-cyan) jump dramatically. This creates false visual
 * boundaries and hides real gradients, misleading readers.
 *
 * Method (sequential scales):
 *   1. Sample the scale at evenly-spaced intervals (already done
 *      by resolveScaleColors - typically 16 samples).
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
 * Method (diverging scales):
 *   A correctly designed diverging palette has a low-chroma
 *   midpoint - so consecutive steps near the centre are small
 *   while steps near the endpoints are large. Measured across
 *   the full sequence, that V-shape always produces a high
 *   max/min ratio and CV. So we split the samples at the
 *   midpoint and run the sequential analysis on each half
 *   independently. Within a half ("midpoint → endpoint"),
 *   a well-designed palette is expected to have uniform steps.
 *   Both halves include the midpoint sample so that a sudden
 *   change right at the centre is caught on each side.
 *
 * Why CIEDE2000 and not just lightness?
 *   A scale could have perfectly monotonic lightness but still
 *   have non-uniform perceptual steps because hue shifts unevenly.
 *   CIEDE2000 captures the full perceptual picture.
 *
 * References:
 *   Borland & Taylor (2007), "Rainbow Color Map (Still) Harmful"
 *   Crameri, Shephard & Heron (2020), "Misuse of color in science"
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
export const CV_WARNING_THRESHOLD = 0.3;

/**
 * Max/min step ratio above this → localized jump (warning) for
 * sequential scales (analysed across all ~16 samples).
 *
 * A ratio of 4 means one step "looks" 4× bigger than another.
 */
export const MAX_MIN_RATIO_THRESHOLD = 4;

/**
 * Max/min step ratio above this → localized jump (warning) for the
 * halves of a diverging scale.
 *
 * Looser than the sequential threshold for two reasons:
 *
 *   1. A half typically has ~5 consecutive steps, so the ratio is
 *      more sensitive to a single outlier than the ~15-step
 *      sequential case.
 *
 *   2. Well-designed diverging palettes like ColorBrewer RdBu have
 *      step ratios around 4× per half by construction - they're
 *      perceptually uniform in CIELAB L*, but ΔE folds in chroma
 *      changes too, and on a half you have saturated→desaturated
 *      transitions that produce large ΔE next to near-white pure
 *      lightness steps that produce small ΔE. That structural
 *      ratio isn't a perceptual defect, so the threshold for
 *      flagging a "real" jump on a half is set above it.
 *
 * Rainbow-style problem regions (e.g. spectral's upper half) have
 * ratios well above 5, so detection of genuine problems is preserved.
 */
export const MAX_MIN_RATIO_HALF_THRESHOLD = 5;

/**
 * Minimum number of colors needed for meaningful full-scale analysis.
 * With fewer than 5 colors, CV is unreliable.
 */
export const MIN_COLORS_FOR_ANALYSIS = 5;

/**
 * Minimum number of colors needed in a half for meaningful per-half
 * analysis. Each half spans ~half the samples, so we relax the count
 * a bit; below this the per-half CV is too noisy to trust.
 */
export const MIN_COLORS_FOR_HALF_ANALYSIS = 4;

// ─── Types ───────────────────────────────────────────────────────

/** One step between consecutive colors. */
export interface PerceptualStep {
  /** Index of the first color in the original full-scale array (0-based). */
  indexA: number;
  /** Index of the second color in the original full-scale array (0-based). */
  indexB: number;
  /** CSS color string of the first color. */
  colorA: string;
  /** CSS color string of the second color. */
  colorB: string;
  /** CIEDE2000 ΔE between the two colors. */
  deltaE: number;
}

/**
 * Step-uniformity statistics computed over a list of consecutive
 * pairs (either the whole sequential scale, or a single half of a
 * diverging scale).
 */
export interface HalfUniformity {
  steps: PerceptualStep[];
  mean: number;
  stdDev: number;
  cv: number;
  maxStep: number;
  minStep: number;
  maxMinRatio: number;
}

/** Full result of a sequential uniformity analysis. */
export interface UniformityAnalysisResult extends HalfUniformity {
  /** Whether there are enough colors to analyze. */
  hasSufficientColors: boolean;
}

/**
 * Full result of a diverging uniformity analysis.
 *
 * `left` covers samples [0 .. midIndex]; `right` covers samples
 * [midIndex .. n-1]. The midpoint sample is included in both
 * halves so a sudden change at the centre is caught on either side.
 *
 * Step indices on each half use the SAME numbering as the original
 * full-scale array (so renderer percentage labels like "50%→63%"
 * still refer to overall scale position, not half-position).
 */
export interface DivergingUniformityAnalysisResult {
  /** Sample index of the midpoint (Math.floor(n / 2)). */
  midIndex: number;
  /** Uniformity stats for the left half (start → midpoint). */
  left: HalfUniformity;
  /** Uniformity stats for the right half (midpoint → end). */
  right: HalfUniformity;
  /** Whether both halves have enough samples for reliable analysis. */
  hasSufficientColors: boolean;
}

// ─── Core math ───────────────────────────────────────────────────

const computeDeltaE = differenceCiede2000();

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * An "empty" HalfUniformity, returned when there are too few steps
 * to compute meaningful statistics. The zero values keep downstream
 * consumers safe from divide-by-zero or NaN.
 */
function emptyHalf(): HalfUniformity {
  return {
    steps: [],
    mean: 0,
    stdDev: 0,
    cv: 0,
    maxStep: 0,
    minStep: 0,
    maxMinRatio: 1,
  };
}

/**
 * Compute uniformity stats for a pre-built list of consecutive steps.
 *
 * Returns an "empty" result with all-zero stats when there are fewer
 * than 2 steps (because variance, ratio, etc. aren't defined).
 */
function statsFromSteps(steps: PerceptualStep[]): HalfUniformity {
  if (steps.length < 2) {
    if (steps.length === 1) {
      // One step → trivially "uniform" but report the value so
      // anything querying mean/maxStep gets something sensible.
      const only = steps[0].deltaE;
      return {
        steps,
        mean: only,
        stdDev: 0,
        cv: 0,
        maxStep: only,
        minStep: only,
        maxMinRatio: 1,
      };
    }
    return emptyHalf();
  }

  const deltaEs = steps.map((s) => s.deltaE);
  const mean = round2(deltaEs.reduce((sum, d) => sum + d, 0) / deltaEs.length);

  const variance = deltaEs.reduce((sum, d) => sum + (d - mean) ** 2, 0) / deltaEs.length;
  const stdDev = round2(Math.sqrt(variance));

  const cv = mean > 0 ? round2(stdDev / mean) : 0;

  const maxStep = round2(Math.max(...deltaEs));
  const minStep = round2(Math.min(...deltaEs));
  const maxMinRatio = minStep > 0 ? round2(maxStep / minStep) : Infinity;

  return {steps, mean, stdDev, cv, maxStep, minStep, maxMinRatio};
}

/**
 * Build the consecutive-step list for a contiguous slice of the
 * scale, using the ORIGINAL full-scale indices so renderer labels
 * stay accurate.
 *
 * `startIndex` is the position in the original `colors` array where
 * `slice` begins (inclusive). `parsedSlice` holds pre-parsed culori
 * colors aligned with `slice`, with undefined for unparseable values.
 */
function stepsForSlice(slice: string[], parsedSlice: ReturnType<typeof parse>[], startIndex: number): PerceptualStep[] {
  const steps: PerceptualStep[] = [];

  for (let i = 0; i < slice.length - 1; i++) {
    const a = parsedSlice[i];
    const b = parsedSlice[i + 1];
    if (!a || !b) continue;

    const deltaE = computeDeltaE(a, b);

    steps.push({
      indexA: startIndex + i,
      indexB: startIndex + i + 1,
      colorA: slice[i],
      colorB: slice[i + 1],
      deltaE: round2(deltaE),
    });
  }

  return steps;
}

// ─── Public API: sequential ──────────────────────────────────────

/**
 * Analyze the perceptual uniformity of a sequential color scale.
 *
 * Computes CIEDE2000 ΔE between each consecutive pair and measures
 * how evenly distributed the steps are.
 *
 * @param colors - Array of CSS color strings (sequential order).
 * @returns Analysis result with step values and evenness metrics.
 */
export function analyzePerceptualUniformity(colors: string[]): UniformityAnalysisResult {
  if (colors.length < MIN_COLORS_FOR_ANALYSIS) {
    return {...emptyHalf(), hasSufficientColors: false};
  }

  const parsed = colors.map((c) => parse(c));
  const steps = stepsForSlice(colors, parsed, 0);

  if (steps.length < 2) {
    return {...statsFromSteps(steps), hasSufficientColors: false};
  }

  return {...statsFromSteps(steps), hasSufficientColors: true};
}

// ─── Public API: diverging ───────────────────────────────────────

/**
 * Analyze the perceptual uniformity of a diverging color scale by
 * splitting at the midpoint and running the analysis on each half
 * independently.
 *
 * Both halves include the midpoint sample, so a kink right at the
 * centre contributes a step on each side.
 *
 * Step indices are kept in the ORIGINAL full-scale numbering, so
 * downstream renderers can label them as percentages of the whole
 * scale ("50%→63%") rather than half-relative positions.
 *
 * @param colors - Array of CSS color strings (diverging order).
 */
export function analyzeDivergingUniformity(colors: string[]): DivergingUniformityAnalysisResult {
  const n = colors.length;
  const midIndex = Math.floor(n / 2);

  // Both halves include the midpoint sample.
  const leftSlice = colors.slice(0, midIndex + 1);
  const rightSlice = colors.slice(midIndex);

  // Pre-parse just once (parse is the expensive part).
  const parsedLeft = leftSlice.map((c) => parse(c));
  const parsedRight = rightSlice.map((c) => parse(c));

  const leftSteps = stepsForSlice(leftSlice, parsedLeft, 0);
  const rightSteps = stepsForSlice(rightSlice, parsedRight, midIndex);

  const left = statsFromSteps(leftSteps);
  const right = statsFromSteps(rightSteps);

  // Reliable per-half stats need enough samples on each side AND
  // at least 2 steps per half (so variance is meaningful).
  const enoughSamples =
    leftSlice.length >= MIN_COLORS_FOR_HALF_ANALYSIS && rightSlice.length >= MIN_COLORS_FOR_HALF_ANALYSIS;
  const enoughSteps = leftSteps.length >= 2 && rightSteps.length >= 2;

  return {
    midIndex,
    left,
    right,
    hasSufficientColors: enoughSamples && enoughSteps,
  };
}
