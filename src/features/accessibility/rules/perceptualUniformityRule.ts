/**
 * perceptualUniformityRule.ts
 *
 * Accessibility rule that checks whether sequential color scales
 * have perceptually uniform steps — equal data intervals should
 * produce equal perceived color changes.
 *
 * Non-uniform scales (like rainbow) create false visual boundaries
 * and hide real gradients, misleading readers about the data.
 *
 * Two severity tiers based on the coefficient of variation (CV):
 *   CV > 0.5  → 'warning'  (clearly non-uniform, misleading)
 *   CV 0.3–0.5 → 'info'   (moderately uneven, could be improved)
 *
 * An additional check: if the max/min step ratio exceeds 4,
 * a warning is raised even if CV is below 0.5, because a single
 * localized jump can be just as misleading as overall unevenness.
 *
 * Only checks sequential scales — categorical scales have no
 * "adjacent step" concept. Only checks explicit author-defined
 * scales (not Vega-Lite defaults).
 *
 * Architecture:
 *   1. resolveScaleColors             — reused from CVD/lightness rules
 *   2. perceptualUniformityAnalysis   — compute step ΔE and evenness
 *   3. this file                      — orchestrate and produce issues
 */

import type {AccessibilityIssue, AccessibilityRule} from '../types.js';
import {resolveScaleColors, type ResolvedScale} from './colorblindSafety/resolveScaleColors.js';
import {
  analyzePerceptualUniformity,
  type UniformityAnalysisResult,
  CV_OK_THRESHOLD,
  CV_WARNING_THRESHOLD,
  MAX_MIN_RATIO_THRESHOLD,
} from './perceptualUniformityAnalysis.js';

// ─── Domain resolution ───────────────────────────────────────────

/** Domain and field info for a color encoding channel. */
interface DomainInfo {
  /** The field name, e.g. "temperature". */
  fieldName: string | null;
  /** Explicit [min, max] domain, if set via scale.domain. */
  domain: [number, number] | null;
}

/**
 * Try to extract the field name and explicit numeric domain
 * from the encoding channel that produced this scale.
 *
 * Only returns a domain when scale.domain is an explicit
 * two-element numeric array — inferred domains from data
 * are not available at spec-analysis time.
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

/** Shared evidence builder for all three issue types. */
function buildStepEvidence(
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
    steps: analysis.steps.map((s) => ({
      deltaE: s.deltaE,
      colorA: s.colorA,
      colorB: s.colorB,
      indexA: s.indexA,
      indexB: s.indexB,
    })),
  };
}

// ─── Issue builders ──────────────────────────────────────────────

/**
 * Build a warning for a clearly non-uniform scale (CV > 0.5).
 */
function buildWarningIssue(
  scale: ResolvedScale,
  analysis: UniformityAnalysisResult,
  domainInfo: DomainInfo,
): AccessibilityIssue {
  const schemeNote = scale.schemeName
    ? ` (scheme '${scale.schemeName}')`
    : '';

  return {
    ruleId: 'vl-a11y-perceptual-uniformity:high-cv',
    severity: 'warning',

    message:
      `The '${scale.channel}' sequential scale${schemeNote} is not ` +
      `perceptually uniform. When moving between equally spaced ` +
      `data values, some intervals produce a large visible color ` +
      `change while others produce almost none ` +
      `(${analysis.maxMinRatio}× difference between the biggest ` +
      `and smallest color change). Unevenness score (CV): ` +
      `${analysis.cv} (0 = perfectly even, above 0.5 = problematic). ` +
      `This can create false visual boundaries and make some data ` +
      `differences appear larger or smaller than they really are.`,

    suggestion:
      'Use a perceptually uniform scheme such as "viridis", ' +
      '"cividis", or "plasma" where equal data steps produce ' +
      'equal visual changes.',

    jsonPointer: scale.jsonPointer,

    evidence: buildStepEvidence(scale, analysis, domainInfo),
  };
}

/**
 * Build an info for a moderately uneven scale (CV 0.3–0.5).
 */
function buildInfoIssue(
  scale: ResolvedScale,
  analysis: UniformityAnalysisResult,
  domainInfo: DomainInfo,
): AccessibilityIssue {
  const schemeNote = scale.schemeName
    ? ` (scheme '${scale.schemeName}')`
    : '';

  return {
    ruleId: 'vl-a11y-perceptual-uniformity:moderate-cv',
    severity: 'info',

    message:
      `The '${scale.channel}' sequential scale${schemeNote} has ` +
      `somewhat uneven color distribution. When moving between ` +
      `equally spaced data values, some intervals produce a ` +
      `noticeably larger color change than others ` +
      `(${analysis.maxMinRatio}× difference). Unevenness score ` +
      `(CV): ${analysis.cv} (0 = perfectly even, above 0.5 = ` +
      `problematic). This may not faithfully represent the data.`,

    suggestion:
      'For more faithful data representation, consider a ' +
      'perceptually uniform scheme like "viridis" or "cividis".',

    jsonPointer: scale.jsonPointer,

    evidence: buildStepEvidence(scale, analysis, domainInfo),
  };
}

/**
 * Build a warning for a localized jump (max/min ratio > 4)
 * that the CV alone might not have caught.
 *
 * Only produced when CV is in the OK or moderate range but
 * the max/min ratio is extreme — this means most steps are
 * even except for one big outlier.
 */
function buildJumpIssue(
  scale: ResolvedScale,
  analysis: UniformityAnalysisResult,
  domainInfo: DomainInfo,
): AccessibilityIssue {
  const schemeNote = scale.schemeName
    ? ` (scheme '${scale.schemeName}')`
    : '';

  return {
    ruleId: 'vl-a11y-perceptual-uniformity:localized-jump',
    severity: 'warning',

    message:
      `The '${scale.channel}' sequential scale${schemeNote} has ` +
      `a sudden color jump — at one point in the scale, the color ` +
      `changes ${analysis.maxMinRatio}× more than at the smoothest ` +
      `point. This creates a false visual boundary, making it look ` +
      `like there is a sharp break in the data when there may not ` +
      `be one.`,

    suggestion:
      'Consider a perceptually uniform scheme such as "viridis" ' +
      'or "cividis", or adjust your custom scale so that color ' +
      'changes are more evenly distributed.',

    jsonPointer: scale.jsonPointer,

    evidence: buildStepEvidence(scale, analysis, domainInfo),
  };
}

// ─── The rule ────────────────────────────────────────────────────

export const perceptualUniformityRule: AccessibilityRule = {
  id: 'vl-a11y-perceptual-uniformity',

  description:
    'Checks whether sequential color scales have perceptually ' +
    'uniform steps using CIEDE2000 between consecutive colors. ' +
    'Non-uniform scales create false visual boundaries.',

  evaluate(spec: Record<string, any>): AccessibilityIssue[] {
    const scales = resolveScaleColors(spec);
    const issues: AccessibilityIssue[] = [];

    for (const scale of scales) {
      // Only check sequential scales — categorical has no "steps"
      if (scale.scaleType !== 'sequential') continue;

      const analysis = analyzePerceptualUniformity(scale.colors);

      // Skip if not enough colors for reliable analysis
      if (!analysis.hasSufficientColors) continue;

      const domainInfo = resolveDomainInfo(spec, scale.channel);

      if (analysis.cv > CV_WARNING_THRESHOLD) {
        issues.push(buildWarningIssue(scale, analysis, domainInfo));
      } else if (analysis.cv > CV_OK_THRESHOLD) {
        issues.push(buildInfoIssue(scale, analysis, domainInfo));
      } else if (analysis.maxMinRatio > MAX_MIN_RATIO_THRESHOLD) {
        issues.push(buildJumpIssue(scale, analysis, domainInfo));
      }
    }

    return issues;
  },
};