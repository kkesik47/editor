/**
 * recommendations/colorRiskRecs.ts
 *
 * Recommendations for issues from `colorRiskRule` (the family-based
 * combination engine, e.g. "red + green", "brown + green + red").
 *
 * Why this file exists separately from colorblindSafetyRecs.ts:
 *
 *   colorRiskRule fires on color FAMILIES detected in the spec
 *   (e.g. "this scale contains a red and a green color"), regardless
 *   of how the colors were specified. Its issues do NOT carry a
 *   `scaleType` field — the rule looks across `mark.{color|fill|stroke}`,
 *   `encoding.*.value`, `scale.range`, `scale.scheme`, and
 *   `config.range.*`, so the "scale type" concept doesn't always apply.
 *
 *   The CVD simulation rule (colorblindSafetyRule), in contrast, only
 *   evaluates `scale.range` and `scale.scheme` and always knows the
 *   scale type. Its recommendations key off that field.
 *
 *   In most cases the two rules fire together and the dedup logic in
 *   `evaluateVegaLiteAccessibility.ts` removes the colorRiskRule issue
 *   when CVD covers the same scale. But colorRiskRule can survive
 *   dedup — e.g. when red+green appear in `mark.fill` and `mark.stroke`,
 *   or in `config.range.category`. Those surviving issues deserve their
 *   own recommendations, hence this file.
 *
 * Recommendation strategy:
 *
 *   We infer the scale context from the issue's `jsonPointer` and the
 *   spec, then offer the corresponding scheme-swap recommendations:
 *
 *     - Pointer ends in /scale/range/N        → categorical swaps
 *     - Pointer ends in /scale/scheme         → infer type from scheme name
 *     - Pointer ends in /mark/color           → single-color swap (not yet implemented)
 *     - Pointer in /config/range/*            → categorical swaps
 *
 *   When we can confidently classify the context as categorical, we
 *   reuse the categorical recommendations from colorblindSafetyRecs.
 *   When we can't (e.g. mark.fill on a non-categorical encoding), we
 *   currently emit no recommendations — the user still sees the warning
 *   message and the suggestion text, just no clickable fixes.
 */

import type {AccessibilityIssue} from '../types.js';
import type {Recommendation, VegaLiteSpec} from './types.js';
import {setScheme, parentPointer} from './specMutators.js';
import {findScheme} from './schemeCatalog.js';

// ─── Context inference ──────────────────────────────────────────

type RiskContext =
  | {kind: 'categorical-range'; scalePointer: string}
  | {kind: 'sequential-range'; scalePointer: string}
  | {kind: 'diverging-range'; scalePointer: string}
  | {kind: 'unknown'};

/**
 * Try to figure out what kind of scale (if any) the risk-rule issue
 * points at, so we can offer matching scheme swaps.
 *
 * Strategy:
 *   1. Walk up the issue's JSON pointer looking for `.../scale/range`
 *      or `.../scale/scheme`.
 *   2. If found, look at the parent encoding channel's `type` field
 *      to determine whether the scale is categorical or sequential.
 *   3. Fall back to inferring from the scheme name (e.g. "viridis"
 *      implies sequential).
 *
 * Returns 'unknown' when the pointer doesn't address a scale we can
 * recommend a swap for (e.g. mark.fill, config.range.category).
 * Those cases get no recommendations in this first cut.
 */
function inferRiskContext(
  issue: AccessibilityIssue,
  spec: VegaLiteSpec,
): RiskContext {
  const pointer = issue.jsonPointer;
  if (!pointer) return {kind: 'unknown'};

  // Walk up the pointer until we hit /scale/range or /scale/scheme.
  // Pointer examples we want to handle:
  //   /encoding/color/scale/range/0       (categorical range entry)
  //   /encoding/color/scale/scheme        (scheme reference)
  const segments = pointer.split('/').filter(Boolean);
  const scaleIdx = segments.indexOf('scale');
  if (scaleIdx === -1) return {kind: 'unknown'};

  // We need an /encoding/<channel>/scale prefix to look at the
  // field type. Reject /config/range/... etc. for now.
  if (segments[0] !== 'encoding' || scaleIdx < 2) return {kind: 'unknown'};

  const channel = segments[1];
  const scalePointer = '/' + segments.slice(0, scaleIdx + 1).join('/');

  // Read the encoding channel definition for its `type` field.
  const channelDef = (spec as any)?.encoding?.[channel];
  const fieldType = channelDef?.type;

  // Nominal/ordinal → categorical. Quantitative/temporal → sequential
  // (we don't try to distinguish diverging here — the CVD rule covers
  // the cases where diverging matters, and red+green almost always
  // means a categorical mistake in practice).
  if (fieldType === 'nominal') {
    return {kind: 'categorical-range', scalePointer};
  }
  if (fieldType === 'ordinal') {
    // Ordinal is technically ordered, but red+green pairings on
    // ordinal scales still mean categorical-looking fixes apply
    // (tableau10 etc. work fine for ordinal data).
    return {kind: 'categorical-range', scalePointer};
  }
  if (fieldType === 'quantitative' || fieldType === 'temporal') {
    return {kind: 'sequential-range', scalePointer};
  }

  // Last resort: infer from scheme name if we can find one.
  const schemeName: unknown = channelDef?.scale?.scheme;
  if (typeof schemeName === 'string') {
    const scheme = findScheme(schemeName);
    if (scheme?.type === 'sequential') {
      return {kind: 'sequential-range', scalePointer};
    }
    if (scheme?.type === 'diverging') {
      return {kind: 'diverging-range', scalePointer};
    }
    if (scheme?.type === 'categorical') {
      return {kind: 'categorical-range', scalePointer};
    }
  }

  return {kind: 'unknown'};
}

// ─── Helper factory ─────────────────────────────────────────────

/**
 * Build a "swap to a specific scheme" recommendation for the risk
 * rule. Same shape as the CVD version but applicability is gated by
 * the inferred risk context (since the issue evidence doesn't carry
 * a scale type directly).
 */
function buildRiskSwap(args: {
  id: string;
  label: string;
  description: string;
  schemeName: string;
  appliesToContext: (ctx: RiskContext) => boolean;
}): Recommendation {
  return {
    id: args.id,
    label: args.label,
    description: args.description,
    family: 'replacement',

    applicableWhen(issue, spec) {
      const ctx = inferRiskContext(issue, spec);
      return args.appliesToContext(ctx);
    },

    apply(issue, spec) {
      // We use the inferred scale pointer rather than parentPointer
      // because the issue's pointer often addresses one element of a
      // range array (e.g. /scale/range/0) — its parent is the range
      // array itself, not the scale object setScheme needs.
      const ctx = inferRiskContext(issue, spec);
      const scalePointer =
        ctx.kind === 'unknown' ? parentPointer(issue.jsonPointer) : ctx.scalePointer;
      return setScheme(spec, scalePointer, args.schemeName);
    },
  };
}

// ─── Categorical recommendations ────────────────────────────────

// These mirror the categorical recs in colorblindSafetyRecs.ts.
// We don't import and reuse those directly because their
// `applicableWhen` reads `evidence.scaleType` which the risk rule
// doesn't emit — so we need a parallel set keyed on context inference.

export const riskSwapToTableau10 = buildRiskSwap({
  id: 'risk-swap-to-tableau10',
  label: 'Switch to tableau10',
  description:
    "Tableau's standard categorical palette. Designed for strong " +
    'discriminability under simulated color vision deficiencies. ' +
    'Replaces the explicit colors with a CVD-safe alternative.',
  schemeName: 'tableau10',
  appliesToContext: (ctx) => ctx.kind === 'categorical-range',
});

export const riskSwapToSet2 = buildRiskSwap({
  id: 'risk-swap-to-set2',
  label: 'Switch to set2',
  description:
    'Muted ColorBrewer categorical palette. Best when the original ' +
    'design was non-vibrant and a softer palette fits the visual tone.',
  schemeName: 'set2',
  appliesToContext: (ctx) => ctx.kind === 'categorical-range',
});

export const riskSwapToDark2 = buildRiskSwap({
  id: 'risk-swap-to-dark2',
  label: 'Switch to dark2',
  description:
    'Higher-saturation ColorBrewer categorical palette. Best when the ' +
    'original design was vibrant and you want to keep strong color ' +
    'separation between categories.',
  schemeName: 'dark2',
  appliesToContext: (ctx) => ctx.kind === 'categorical-range',
});

export const riskSwapToObservable10 = buildRiskSwap({
  id: 'risk-swap-to-observable10',
  label: 'Switch to observable10',
  description:
    "Observable's default categorical palette. Modern, well-balanced " +
    'between vibrancy and discriminability under CVD.',
  schemeName: 'observable10',
  appliesToContext: (ctx) => ctx.kind === 'categorical-range',
});

// ─── Sequential recommendations ─────────────────────────────────

export const riskSwapToViridis = buildRiskSwap({
  id: 'risk-swap-to-viridis',
  label: 'Switch to viridis',
  description:
    'Perceptually uniform sequential palette, CVD-safe. Strong neutral ' +
    'default — replaces the explicit colors with a continuous palette ' +
    'that has no problematic family pairings.',
  schemeName: 'viridis',
  appliesToContext: (ctx) => ctx.kind === 'sequential-range',
});

export const riskSwapToCividis = buildRiskSwap({
  id: 'risk-swap-to-cividis',
  label: 'Switch to cividis',
  description:
    'Sequential palette designed so CVD and non-CVD viewers see ' +
    'nearly the same scale.',
  schemeName: 'cividis',
  appliesToContext: (ctx) => ctx.kind === 'sequential-range',
});

// ─── Diverging recommendations ──────────────────────────────────

export const riskSwapToBlueOrange = buildRiskSwap({
  id: 'risk-swap-to-blueorange',
  label: 'Switch to blueorange',
  description:
    'Diverging palette on the blue-orange axis, which is preserved ' +
    'under most types of color vision deficiency. Safer alternative ' +
    'when the original red/green pairing was meant to encode opposing ' +
    'directions around a midpoint.',
  schemeName: 'blueorange',
  appliesToContext: (ctx) => ctx.kind === 'diverging-range',
});

// ─── Registry ────────────────────────────────────────────────────

export const colorRiskRecommendations: Recommendation[] = [
  // Categorical (most common case for red-green pairings)
  riskSwapToTableau10,
  riskSwapToSet2,
  riskSwapToDark2,
  riskSwapToObservable10,
  // Sequential
  riskSwapToViridis,
  riskSwapToCividis,
  // Diverging
  riskSwapToBlueOrange,
];