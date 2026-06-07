/**
 * perceptualUniformityRule.ts
 *
 * Accessibility rule that checks whether ordered color scales have
 * perceptually uniform steps — equal data intervals should produce
 * equal perceived color changes.
 *
 * Non-uniform scales (like rainbow) create false visual boundaries
 * and hide real gradients, misleading readers about the data.
 *
 * Two severity tiers based on the coefficient of variation (CV):
 *   CV > 0.5  → 'warning'  (clearly non-uniform, misleading)
 *   CV 0.3–0.5 → 'info'    (moderately uneven, could be improved)
 *
 * An additional check: if the max/min step ratio exceeds 4, a
 * warning is raised even if CV is below 0.5, because a single
 * localized jump can be just as misleading as overall unevenness.
 *
 * Sequential vs diverging:
 *
 *   Sequential scales are checked across the full sample sequence.
 *
 *   Diverging scales are checked per-half (midpoint → endpoint),
 *   because their V-shape around a low-chroma midpoint makes global
 *   step statistics structurally high even for well-designed
 *   palettes like blueorange. The worst-performing half drives the
 *   issue. The renderer's "biggest / smallest color change" pairs
 *   come from that half, while the gradient preview still shows the
 *   full scale (so the user stays oriented to what they're editing).
 *
 * Categorical scales are skipped — they have no notion of
 * consecutive steps to measure.
 *
 * Architecture:
 *   1. resolveScaleColors            — reused from CVD/lightness rules
 *   2. perceptualUniformityAnalysis  — compute step ΔE and evenness
 *   3. this file                     — orchestrate and produce issues
 */

import type {AccessibilityIssue, AccessibilityRule} from '../types.js';
import {resolveScaleColors, type ResolvedScale} from './colorblindSafety/resolveScaleColors.js';
import {
  analyzePerceptualUniformity,
  analyzeDivergingUniformity,
  type UniformityAnalysisResult,
  type DivergingUniformityAnalysisResult,
  type HalfUniformity,
  type PerceptualStep,
  CV_OK_THRESHOLD,
  CV_WARNING_THRESHOLD,
  MAX_MIN_RATIO_THRESHOLD,
  MAX_MIN_RATIO_HALF_THRESHOLD,
} from './perceptualUniformityAnalysis.js';
import {BORLAND_TAYLOR_2007, CRAMERI_2020, NUNEZ_2018, SHARMA_CIEDE_2005, BERGMAN_1995} from '../references.js';
// ─── Domain resolution ───────────────────────────────────────────

/** Domain and field info for a color encoding channel. */
interface DomainInfo {
  /** The field name, e.g. "temperature". */
  fieldName: string | null;
  /** Explicit [min, max] domain, if set via scale.domain. */
  domain: [number, number] | null;
}

/**
 * Try to extract the field name and explicit numeric domain from
 * the encoding channel that produced this scale.
 *
 * Only returns a domain when scale.domain is an explicit two-element
 * numeric array — inferred domains from data are not available at
 * spec-analysis time. Three-element domains (the diverging case) are
 * intentionally skipped, because the preview formatter expects
 * [min, max] for percentage interpolation.
 */
function resolveDomainInfo(
  spec: Record<string, any>,
  channel: string,
): DomainInfo {
  const channelDef = spec?.encoding?.[channel];
  if (!channelDef || typeof channelDef !== 'object') {
    return {fieldName: null, domain: null};
  }

  const fieldName =
    typeof channelDef.field === 'string' ? channelDef.field : null;

  const rawDomain = channelDef?.scale?.domain;
  let domain: [number, number] | null = null;

  if (
    Array.isArray(rawDomain) &&
    rawDomain.length === 2 &&
    typeof rawDomain[0] === 'number' &&
    typeof rawDomain[1] === 'number'
  ) {
    domain = [rawDomain[0], rawDomain[1]];
  }

  return {fieldName, domain};
}

// ─── Severity classification ─────────────────────────────────────

/** Which severity tier a step-uniformity profile falls into. */
type UniformityVerdict = 'warning' | 'info' | 'jump' | 'ok';

/**
 * Map CV + max/min ratio to a verdict.
 *
 * CV high → warning, CV moderate → info, otherwise check the
 * localized-jump heuristic against the supplied threshold. "ok"
 * means nothing to report.
 *
 * The `maxMinRatioThreshold` parameter is what lets sequential and
 * diverging analyses share this function but use different jump
 * thresholds — see MAX_MIN_RATIO_THRESHOLD vs
 * MAX_MIN_RATIO_HALF_THRESHOLD in the analysis module.
 */
function classify(
  cv: number,
  maxMinRatio: number,
  maxMinRatioThreshold: number,
): UniformityVerdict {
  if (cv > CV_WARNING_THRESHOLD) return 'warning';
  if (cv > CV_OK_THRESHOLD) return 'info';
  if (maxMinRatio > maxMinRatioThreshold) return 'jump';
  return 'ok';
}

/**
 * Severity rank for comparing two halves of a diverging scale.
 *
 * Higher rank = more serious issue. When the halves disagree the
 * issue is driven by the worse side so the user sees the most
 * important diagnostic first.
 */
const VERDICT_RANK: Record<UniformityVerdict, number> = {
  ok: 0,
  jump: 1,
  info: 2,
  warning: 3,
};

// ─── Message helpers ─────────────────────────────────────────────

function schemeNoteFor(scale: ResolvedScale): string {
  return scale.schemeName ? ` (scheme '${scale.schemeName}')` : '';
}

/** Phrase the side of a diverging scale for use in messages. */
function describeSide(side: 'lower' | 'upper' | 'both'): string {
  if (side === 'both') return 'both halves';
  return `${side} half`;
}

// ─── Step packaging ──────────────────────────────────────────────

/** Convert PerceptualStep[] into the renderer-friendly evidence shape. */
function packStepsForEvidence(steps: PerceptualStep[]): Record<string, unknown>[] {
  return steps.map((s) => ({
    deltaE: s.deltaE,
    colorA: s.colorA,
    colorB: s.colorB,
    indexA: s.indexA,
    indexB: s.indexB,
  }));
}

// ─── Evidence builders ───────────────────────────────────────────

/** Evidence for a sequential issue: stats from the full-scale analysis. */
function buildSequentialEvidence(
  scale: ResolvedScale,
  analysis: UniformityAnalysisResult,
  domainInfo: DomainInfo,
): Record<string, unknown> {
  return {
    channel: scale.channel,
    scaleType: scale.scaleType,
    schemeName: scale.schemeName ?? null,
    cv: analysis.cv,
    maxMinRatio: analysis.maxMinRatio,
    mean: analysis.mean,
    stdDev: analysis.stdDev,
    maxStep: analysis.maxStep,
    minStep: analysis.minStep,
    stepCount: analysis.steps.length,
    colorCount: scale.colors.length,
    fieldName: domainInfo.fieldName,
    domain: domainInfo.domain,
    steps: packStepsForEvidence(analysis.steps),
  };
}

/**
 * Evidence for a diverging issue.
 *
 * Headline `cv` / `maxMinRatio` / `mean` / `stdDev` etc. come from
 * the worst-performing half (so the user-visible message matches
 * what triggered the warning). `steps` are also from the worst half
 * — these drive the renderer's "biggest / smallest color change"
 * rows, localizing the diagnostic to where the actual problem lives.
 *
 * `colorCount` stays as the full scale length, which keeps the
 * renderer's percentage labels ("50%→63%") accurate against the
 * overall scale rather than the half-slice. Per-half stats are
 * still exposed under `halves` for debugging or future UI variants.
 */
function buildDivergingEvidence(
  scale: ResolvedScale,
  analysis: DivergingUniformityAnalysisResult,
  worst: HalfUniformity,
  side: 'lower' | 'upper' | 'both',
  domainInfo: DomainInfo,
): Record<string, unknown> {
  return {
    channel: scale.channel,
    scaleType: scale.scaleType,
    schemeName: scale.schemeName ?? null,
    cv: worst.cv,
    maxMinRatio: worst.maxMinRatio,
    mean: worst.mean,
    stdDev: worst.stdDev,
    maxStep: worst.maxStep,
    minStep: worst.minStep,
    stepCount: worst.steps.length,
    colorCount: scale.colors.length,
    fieldName: domainInfo.fieldName,
    domain: domainInfo.domain,
    steps: packStepsForEvidence(worst.steps),
    // The renderer normally reconstructs the gradient bar from `steps`.
    // For diverging issues, `steps` only covers the failing half, so we
    // pass the full ordered color list separately and let the preview
    // draw the whole scale as the gradient (option (a) — keeps the user
    // oriented to the scale they're editing) while the biggest /
    // smallest pair rows come from the half.
    gradientColors: scale.colors,
    worstSide: side,
    midIndex: analysis.midIndex,
    halves: {
      lower: {
        cv: analysis.left.cv,
        maxMinRatio: analysis.left.maxMinRatio,
        maxStep: analysis.left.maxStep,
        minStep: analysis.left.minStep,
        stepCount: analysis.left.steps.length,
      },
      upper: {
        cv: analysis.right.cv,
        maxMinRatio: analysis.right.maxMinRatio,
        maxStep: analysis.right.maxStep,
        minStep: analysis.right.minStep,
        stepCount: analysis.right.steps.length,
      },
    },
  };
}

// ─── Sequential issue builders ───────────────────────────────────

function buildSequentialWarning(
  scale: ResolvedScale,
  analysis: UniformityAnalysisResult,
  domainInfo: DomainInfo,
): AccessibilityIssue {
  return {
    ruleId: 'vl-a11y-perceptual-uniformity:high-cv',
    severity: 'info',
    message:
      `The '${scale.channel}' sequential scale${schemeNoteFor(scale)} is ` +
      `not perceptually uniform. When moving between equally spaced ` +
      `data values, some intervals produce a large visible color ` +
      `change while others produce almost none ` +
      `(${analysis.maxMinRatio}× difference between the biggest and ` +
      `smallest color change). Unevenness score (CV): ${analysis.cv} ` +
      `(0 = perfectly even, above 0.5 = problematic). This can create ` +
      `false visual boundaries and make some data differences appear ` +
      `larger or smaller than they really are.`,
    suggestion:
      'Use a perceptually uniform sequential scheme such as ' +
      '"viridis", "cividis", or "plasma" where equal data steps ' +
      'produce equal visual changes.',
    jsonPointer: scale.jsonPointer,
    evidence: buildSequentialEvidence(scale, analysis, domainInfo),
  };
}

function buildSequentialInfo(
  scale: ResolvedScale,
  analysis: UniformityAnalysisResult,
  domainInfo: DomainInfo,
): AccessibilityIssue {
  return {
    ruleId: 'vl-a11y-perceptual-uniformity:moderate-cv',
    severity: 'info',
    message:
      `The '${scale.channel}' sequential scale${schemeNoteFor(scale)} has ` +
      `somewhat uneven color distribution. When moving between equally ` +
      `spaced data values, some intervals produce a noticeably larger ` +
      `color change than others (${analysis.maxMinRatio}× difference). ` +
      `Unevenness score (CV): ${analysis.cv} (0 = perfectly even, ` +
      `above 0.3 = problematic). This may not faithfully represent the data.`,
    suggestion:
      'For more faithful data representation, consider a perceptually ' +
      'uniform scheme like "viridis" or "cividis".',
    jsonPointer: scale.jsonPointer,
    evidence: buildSequentialEvidence(scale, analysis, domainInfo),
  };
}

function buildSequentialJump(
  scale: ResolvedScale,
  analysis: UniformityAnalysisResult,
  domainInfo: DomainInfo,
): AccessibilityIssue {
  return {
    ruleId: 'vl-a11y-perceptual-uniformity:localized-jump',
    severity: 'info',
    message:
      `The '${scale.channel}' sequential scale${schemeNoteFor(scale)} has ` +
      `a sudden color jump — at one point in the scale, the color ` +
      `changes ${analysis.maxMinRatio}× more than at the smoothest ` +
      `point. This creates a false visual boundary, making it look ` +
      `like there is a sharp break in the data when there may not be one.`,
    suggestion:
      'Consider a perceptually uniform scheme such as "viridis" or ' +
      '"cividis", or adjust your custom scale so that color changes ' +
      'are more evenly distributed.',
    jsonPointer: scale.jsonPointer,
    evidence: buildSequentialEvidence(scale, analysis, domainInfo),
  };
}

// ─── Diverging issue builders ────────────────────────────────────

function buildDivergingWarning(
  scale: ResolvedScale,
  analysis: DivergingUniformityAnalysisResult,
  worst: HalfUniformity,
  side: 'lower' | 'upper' | 'both',
  domainInfo: DomainInfo,
): AccessibilityIssue {
  const sideText = describeSide(side);
  return {
    ruleId: 'vl-a11y-perceptual-uniformity:high-cv',
    severity: 'info',
    message:
      `The '${scale.channel}' diverging scale${schemeNoteFor(scale)} is ` +
      `not perceptually uniform within its ${sideText}. When moving ` +
      `between equally spaced data values on that side of the midpoint, ` +
      `some intervals produce a large visible color change while others ` +
      `produce almost none (${worst.maxMinRatio}× difference between ` +
      `the biggest and smallest color change). Unevenness score (CV): ` +
      `${worst.cv} (0 = perfectly even, above 0.5 = problematic). ` +
      `This can create false visual boundaries and make some data ` +
      `differences appear larger or smaller than they really are.`,
    suggestion:
      'Use a perceptually uniform diverging scheme such as ' +
      '"blueorange" or "purpleorange", where equal data steps produce ' +
      'equal visual changes on each side of the midpoint.',
    jsonPointer: scale.jsonPointer,
    evidence: buildDivergingEvidence(scale, analysis, worst, side, domainInfo),
  };
}

function buildDivergingInfo(
  scale: ResolvedScale,
  analysis: DivergingUniformityAnalysisResult,
  worst: HalfUniformity,
  side: 'lower' | 'upper' | 'both',
  domainInfo: DomainInfo,
): AccessibilityIssue {
  const sideText = describeSide(side);
  return {
    ruleId: 'vl-a11y-perceptual-uniformity:moderate-cv',
    severity: 'info',
    message:
      `The '${scale.channel}' diverging scale${schemeNoteFor(scale)} has ` +
      `somewhat uneven color distribution within its ${sideText}. Some ` +
      `intervals produce a noticeably larger color change than others ` +
      `(${worst.maxMinRatio}× difference). Unevenness score (CV): ` +
      `${worst.cv} (0 = perfectly even, above 0.3 = problematic). ` +
      `This may not faithfully represent the data.`,
    suggestion:
      'For more faithful data representation, consider a perceptually ' +
      'uniform diverging scheme like "blueorange" or "purpleorange".',
    jsonPointer: scale.jsonPointer,
    evidence: buildDivergingEvidence(scale, analysis, worst, side, domainInfo),
  };
}

function buildDivergingJump(
  scale: ResolvedScale,
  analysis: DivergingUniformityAnalysisResult,
  worst: HalfUniformity,
  side: 'lower' | 'upper' | 'both',
  domainInfo: DomainInfo,
): AccessibilityIssue {
  const sideText = describeSide(side);
  return {
    ruleId: 'vl-a11y-perceptual-uniformity:localized-jump',
    severity: 'info',
    message:
      `The '${scale.channel}' diverging scale${schemeNoteFor(scale)} has ` +
      `a sudden color jump within its ${sideText} — at one point, the ` +
      `color changes ${worst.maxMinRatio}× more than at the smoothest ` +
      `point on that side. This creates a false visual boundary, making ` +
      `it look like there is a sharp break in the data when there may ` +
      `not be one.`,
    suggestion:
      'Consider a perceptually uniform diverging scheme such as ' +
      '"blueorange" or "purpleorange", or adjust your custom scale so ' +
      'that color changes are more evenly distributed within each half.',
    jsonPointer: scale.jsonPointer,
    evidence: buildDivergingEvidence(scale, analysis, worst, side, domainInfo),
  };
}

// ─── Per-scale evaluation ────────────────────────────────────────

/**
 * Evaluate one sequential scale and emit at most one issue.
 */
function evaluateSequential(
  scale: ResolvedScale,
  domainInfo: DomainInfo,
): AccessibilityIssue | null {
  const analysis = analyzePerceptualUniformity(scale.colors);
  if (!analysis.hasSufficientColors) return null;

  const verdict = classify(
    analysis.cv,
    analysis.maxMinRatio,
    MAX_MIN_RATIO_THRESHOLD,
  );

  switch (verdict) {
    case 'warning':
      return buildSequentialWarning(scale, analysis, domainInfo);
    case 'info':
      return buildSequentialInfo(scale, analysis, domainInfo);
    case 'jump':
      return buildSequentialJump(scale, analysis, domainInfo);
    case 'ok':
      return null;
  }
}

/**
 * Evaluate one diverging scale, per-half, and emit at most one issue.
 *
 * Both halves are classified independently. If both halves are "ok"
 * we emit nothing. Otherwise:
 *   - If the verdicts differ, the worse half drives the issue.
 *   - If both halves tie at the same non-ok verdict, the side is
 *     labelled "both" in the message; the half with higher CV
 *     drives the headline numbers and the renderer pairs.
 */
function evaluateDiverging(
  scale: ResolvedScale,
  domainInfo: DomainInfo,
): AccessibilityIssue | null {
  const analysis = analyzeDivergingUniformity(scale.colors);
  if (!analysis.hasSufficientColors) return null;

  const leftVerdict = classify(
    analysis.left.cv,
    analysis.left.maxMinRatio,
    MAX_MIN_RATIO_HALF_THRESHOLD,
  );
  const rightVerdict = classify(
    analysis.right.cv,
    analysis.right.maxMinRatio,
    MAX_MIN_RATIO_HALF_THRESHOLD,
  );

  if (leftVerdict === 'ok' && rightVerdict === 'ok') return null;

  const leftRank = VERDICT_RANK[leftVerdict];
  const rightRank = VERDICT_RANK[rightVerdict];

  let worstHalf: HalfUniformity;
  let worstVerdict: UniformityVerdict;
  let side: 'lower' | 'upper' | 'both';

  if (leftRank > rightRank) {
    worstHalf = analysis.left;
    worstVerdict = leftVerdict;
    side = 'lower';
  } else if (rightRank > leftRank) {
    worstHalf = analysis.right;
    worstVerdict = rightVerdict;
    side = 'upper';
  } else {
    // Tied at the same non-ok verdict on both halves.
    worstHalf =
      analysis.left.cv >= analysis.right.cv ? analysis.left : analysis.right;
    worstVerdict = leftVerdict; // == rightVerdict here
    side = 'both';
  }

  switch (worstVerdict) {
    case 'warning':
      return buildDivergingWarning(scale, analysis, worstHalf, side, domainInfo);
    case 'info':
      return buildDivergingInfo(scale, analysis, worstHalf, side, domainInfo);
    case 'jump':
      return buildDivergingJump(scale, analysis, worstHalf, side, domainInfo);
    case 'ok':
      return null;
  }
}

// ─── The rule ────────────────────────────────────────────────────

export const perceptualUniformityRule: AccessibilityRule = {
  id: 'vl-a11y-perceptual-uniformity',

  description:
    'Checks whether sequential and diverging color scales have ' +
    'perceptually uniform steps using CIEDE2000 between consecutive ' +
    'colors. Diverging scales are checked per-half so the V-shape ' +
    'around the midpoint is not counted as a defect.',
  references: [BORLAND_TAYLOR_2007, CRAMERI_2020, NUNEZ_2018, SHARMA_CIEDE_2005, BERGMAN_1995],
  evaluate(spec: Record<string, any>): AccessibilityIssue[] {
    const scales = resolveScaleColors(spec);
    const issues: AccessibilityIssue[] = [];

    for (const scale of scales) {
      // Categorical scales have no meaningful "consecutive step" concept.
      if (scale.scaleType === 'categorical') continue;

      const domainInfo = resolveDomainInfo(spec, scale.channel);

      const issue =
        scale.scaleType === 'diverging'
          ? evaluateDiverging(scale, domainInfo)
          : evaluateSequential(scale, domainInfo);

      if (issue) issues.push(issue);
    }

    return issues;
  },
};