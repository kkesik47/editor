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
 * Two comparison strategies are supported:
 *   - Categorical scales → all-pairs comparison
 *   - Sequential scales  → adjacent-pairs only
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
  /** The smallest ΔE₀₀ found among the compared pairs. */
  minDeltaE: number;
  /** All pairs that fell below the distinguishability threshold. */
  problematicPairs: ProblematicPair[];
}

// ─── Configuration ───────────────────────────────────────────────

/**
 * Minimum CIEDE2000 ΔE₀₀ for categorical scales (all pairs).
 *
 * Two categories that drop below this under CVD simulation could be
 * confused in a legend or scatterplot. A value of 10 corresponds to
 * "very clearly different" in normal vision.
 */
export const CATEGORICAL_THRESHOLD = 10;

/**
 * Minimum CIEDE2000 ΔE₀₀ for sequential scales (adjacent steps).
 *
 * Adjacent gradient steps collapsing below this means the progression
 * becomes invisible. A value of 3 is roughly the "clearly noticeable
 * to most observers" boundary.
 */
export const SEQUENTIAL_THRESHOLD = 3;

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

// ─── Core logic ──────────────────────────────────────────────────

/**
 * Simulate one CVD type on a color array and find problematic pairs.
 *
 * @param colors    - Array of CSS color strings to test.
 * @param scaleType - 'categorical' → all pairs; 'sequential' → adjacent only.
 * @param threshold - Minimum ΔE₀₀ below which a pair is flagged.
 * @param cvdType   - Which color vision deficiency to simulate.
 */
function testOneCvdType(
  colors: string[],
  scaleType: ScaleType,
  threshold: number,
  cvdType: CvdType,
): CvdTestResult {
  const simulator = CVD_SIMULATORS[cvdType];

  // Parse every color, simulate CVD, and store the simulated result.
  // `culori.parse` returns undefined for unparseable strings.
  const simulated = colors.map((raw) => {
    const parsed = parse(raw);
    return parsed ? simulator(parsed) : undefined;
  });

  const problematicPairs: ProblematicPair[] = [];
  let minDeltaE = Infinity;

  // Build the list of index pairs to compare
  const pairs = scaleType === 'categorical'
    ? allPairs(colors.length)
    : adjacentPairs(colors.length);

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

  return {
    cvdType,
    minDeltaE: minDeltaE === Infinity ? 0 : round2(minDeltaE),
    problematicPairs,
  };
}

// ─── Pair generators ─────────────────────────────────────────────

/** Generate all unique index pairs (i, j) where i < j. */
function allPairs(length: number): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < length; i++) {
    for (let j = i + 1; j < length; j++) {
      pairs.push([i, j]);
    }
  }
  return pairs;
}

/** Generate adjacent index pairs: (0,1), (1,2), (2,3), ... */
function adjacentPairs(length: number): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < length - 1; i++) {
    pairs.push([i, i + 1]);
  }
  return pairs;
}

/** Round to 2 decimal places for readable output. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Test a color array against all three CVD types.
 *
 * Returns one CvdTestResult per deficiency type, but only those that
 * have at least one problematic pair. Returns an empty array if the
 * scale is safe under all simulated deficiencies.
 *
 * @param colors    - Array of CSS color strings to evaluate.
 * @param scaleType - Determines the comparison strategy.
 */
export function evaluateColorblindSafety(
  colors: string[],
  scaleType: ScaleType,
): CvdTestResult[] {
  const threshold = scaleType === 'categorical'
    ? CATEGORICAL_THRESHOLD
    : SEQUENTIAL_THRESHOLD;

  return ALL_CVD_TYPES
    .map((cvdType) => testOneCvdType(colors, scaleType, threshold, cvdType))
    .filter((result) => result.problematicPairs.length > 0);
}
