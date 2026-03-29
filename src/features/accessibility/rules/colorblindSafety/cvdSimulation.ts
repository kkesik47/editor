/**
 * cvdSimulation.ts
 *
 * Simulates color vision deficiencies (CVD) on a set of colors and
 * measures whether the colors remain distinguishable afterward.
 *
 * Uses the Brettel–Viénot–Mollon model via the `culori` library for
 * physiologically accurate CVD simulation, and CIEDE2000 (ΔE₀₀) for
 * perceptually-weighted color difference measurement.
 *
 * Comparison strategies:
 *
 *   Categorical scales → all-pairs comparison (threshold ΔE 5).
 *
 *   Sequential scales  → distant-pair comparison.
 *     Checks all pairs where the gap is ≥ 25% of the range.
 *     Threshold ΔE 7.
 *
 *   Why "all distant pairs" instead of specific strides?
 *   Schemes like rainbow have fold-over under CVD, but the exact
 *   distance at which hue AND lightness both collapse depends on
 *   the scheme's lightness profile.  Checking only stride n/3 and
 *   n/2 can miss the fold-over point.  Scanning all distant pairs
 *   catches fold-over at any distance ≥ 25% of the range.
 *
 *   Why no adjacent check for sequential?
 *   Adjacent samples from a high-density sampling (16 points) are
 *   only ~6% of the range apart. Even CVD-safe schemes like viridis
 *   have small ΔE between neighbors at that density — that's normal
 *   gradient behavior, not a defect.
 *
 * References:
 *   Brettel, H., Viénot, F., & Mollon, J.D. (1997).
 *   "Computerized simulation of color appearance for dichromats."
 *   Journal of the Optical Society of America A, 14(10), 2647–2655.
 */

import {
  parse,
  formatHex,
  differenceCiede2000,
  filterDeficiencyProt,
  filterDeficiencyDeuter,
  filterDeficiencyTrit,
} from 'culori';

import type {ScaleType} from './resolveScaleColors.js';

// ─── Public types ────────────────────────────────────────────────

/** The three standard dichromacy types tested. */
export type CvdType = 'protanopia' | 'deuteranopia' | 'tritanopia';

/** A pair of colors that became too similar under CVD simulation. */
export interface ProblematicPair {
  /** Index of the first color in the original array. */
  indexA: number;
  /** Index of the second color in the original array. */
  indexB: number;
  /** Original CSS color string of the first color. */
  originalA: string;
  /** Original CSS color string of the second color. */
  originalB: string;
  /** Hex color of the first color after CVD simulation. */
  simulatedA: string;
  /** Hex color of the second color after CVD simulation. */
  simulatedB: string;
  /** CIEDE2000 color difference between the simulated pair. */
  deltaE: number;
}

/** Result of testing one CVD type against a set of colors. */
export interface CvdTestResult {
  /** Which CVD type was simulated. */
  cvdType: CvdType;
  /** The smallest ΔE₀₀ found among all compared pairs. */
  minDeltaE: number;
  /** All pairs that fell below the distinguishability threshold. */
  problematicPairs: ProblematicPair[];
}

// ─── Configuration ───────────────────────────────────────────────

/**
 * Minimum CIEDE2000 ΔE₀₀ for categorical scales (all pairs).
 *
 * CIEDE2000 reference scale:
 *   < 1   imperceptible
 *   1–2   barely perceptible
 *   2–5   noticeable but potentially confusable
 *   > 5   clearly different
 *
 * Below 5, two legend entries could be misidentified.
 */
export const CATEGORICAL_THRESHOLD = 5;

/**
 * Minimum CIEDE2000 ΔE₀₀ for sequential "distant" pairs.
 *
 * Any two data values ≥25% of the range apart must remain clearly
 * different under CVD.  If they collapse, the user cannot read the
 * scale — two distant data values appear identical.
 *
 * We use 7 rather than 10 because:
 *   - ΔE 7 is well above "clearly different" (>5)
 *   - CVD-safe schemes like plasma have worst-case distant-pair
 *     ΔE around 8 under protanopia — threshold 10 false-positives them
 *   - Genuinely problematic schemes like rainbow have fold-over
 *     pairs well below 7
 */
export const SEQUENTIAL_DISTANT_THRESHOLD = 7;

/** Severity of the Brettel simulation (1.0 = full dichromacy). */
const CVD_SEVERITY = 1.0;

// ─── CVD simulators (one per deficiency type) ────────────────────

const CVD_SIMULATORS: Record<CvdType, ReturnType<typeof filterDeficiencyProt>> = {
  protanopia: filterDeficiencyProt(CVD_SEVERITY),
  deuteranopia: filterDeficiencyDeuter(CVD_SEVERITY),
  tritanopia: filterDeficiencyTrit(CVD_SEVERITY),
};

/** All CVD types we test, in order. */
const ALL_CVD_TYPES: CvdType[] = ['protanopia', 'deuteranopia', 'tritanopia'];

/** The CIEDE2000 comparator (instantiated once, reused). */
const computeDeltaE = differenceCiede2000();

// ─── Pair batch types ────────────────────────────────────────────

/** A set of index-pairs to compare, with their own ΔE threshold. */
interface PairBatch {
  pairs: [number, number][];
  threshold: number;
}

// ─── Pair generators ─────────────────────────────────────────────

/** All unique index pairs (i, j) where i < j. */
function allPairs(length: number): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < length; i++) {
    for (let j = i + 1; j < length; j++) {
      pairs.push([i, j]);
    }
  }
  return pairs;
}

/**
 * All pairs (i, j) where j - i >= minGap.
 *
 * This comprehensively covers fold-over at ANY distance ≥ minGap,
 * rather than checking only specific stride values.  This matters
 * for schemes like rainbow where the exact fold-over point depends
 * on both the hue cycle and the lightness profile.
 *
 * Example with length = 16, minGap = 4:
 *   (0,4), (0,5), …, (0,15),
 *   (1,5), (1,6), …, (1,15),
 *   …, (11,15)
 */
function distantPairs(length: number, minGap: number): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < length; i++) {
    for (let j = i + minGap; j < length; j++) {
      pairs.push([i, j]);
    }
  }
  return pairs;
}

// ─── Batch builder ───────────────────────────────────────────────

/**
 * Build the list of pair-batches to evaluate for a given scale type.
 *
 *   Categorical → one batch: all unique pairs, threshold 5.
 *
 *   Sequential  → one batch: all distant pairs (gap ≥ 25% of range),
 *     threshold 7.  This comprehensively catches fold-over at any
 *     distance rather than checking only specific strides.
 */
function buildPairBatches(length: number, scaleType: ScaleType): PairBatch[] {
  if (scaleType === 'categorical') {
    return [{pairs: allPairs(length), threshold: CATEGORICAL_THRESHOLD}];
  }

  // Sequential: all pairs that are at least 25% of the range apart.
  // For 16 samples, minGap = 4 → covers distances from 25% to 100%.
  const minGap = Math.max(2, Math.floor(length / 4));

  return [
    {pairs: distantPairs(length, minGap), threshold: SEQUENTIAL_DISTANT_THRESHOLD},
  ];
}

// ─── Core logic ──────────────────────────────────────────────────

/**
 * Simulate one CVD type on a color array and find problematic pairs.
 */
function testOneCvdType(
  colors: string[],
  scaleType: ScaleType,
  cvdType: CvdType,
): CvdTestResult {
  const simulator = CVD_SIMULATORS[cvdType];

  // Parse every color, simulate CVD, store the simulated result.
  const simulated = colors.map((raw) => {
    const parsed = parse(raw);
    return parsed ? simulator(parsed) : undefined;
  });

  const problematicPairs: ProblematicPair[] = [];
  let minDeltaE = Infinity;

  const batches = buildPairBatches(colors.length, scaleType);

  for (const {pairs, threshold} of batches) {
    for (const [i, j] of pairs) {
      const colorA = simulated[i];
      const colorB = simulated[j];
      if (!colorA || !colorB) continue;

      const dE = computeDeltaE(colorA, colorB);
      if (dE < minDeltaE) minDeltaE = dE;

      if (dE < threshold) {
        problematicPairs.push({
          indexA: i,
          indexB: j,
          originalA: colors[i],
          originalB: colors[j],
          simulatedA: formatHex(colorA) ?? '',
          simulatedB: formatHex(colorB) ?? '',
          deltaE: round2(dE),
        });
      }
    }
  }

  return {
    cvdType,
    minDeltaE: minDeltaE === Infinity ? 0 : round2(minDeltaE),
    problematicPairs,
  };
}

/** Round to 2 decimal places for readable output. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Test a color array against all three CVD types.
 *
 * Returns one CvdTestResult per deficiency type, but only those
 * that have at least one problematic pair.  Returns an empty array
 * if the scale is safe under all simulated deficiencies.
 *
 * @param colors    - Array of CSS color strings to evaluate.
 * @param scaleType - Determines the comparison strategy.
 */
export function evaluateColorblindSafety(
  colors: string[],
  scaleType: ScaleType,
): CvdTestResult[] {
  return ALL_CVD_TYPES
    .map((cvdType) => testOneCvdType(colors, scaleType, cvdType))
    .filter((result) => result.problematicPairs.length > 0);
}