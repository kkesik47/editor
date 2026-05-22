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
 *   `scaleType` field — the rule looks across many spec locations
 *   (mark colors, encoding values, scale ranges, config ranges), so
 *   the "scale type" concept doesn't always apply.
 *
 *   The CVD simulation rule (colorblindSafetyRule), in contrast, only
 *   evaluates `scale.range` and `scale.scheme` and always knows the
 *   scale type. Its recommendations key off that field.
 *
 *   In most cases the two rules fire together and the dedup logic in
 *   `evaluateVegaLiteAccessibility.ts` removes the colorRiskRule issue
 *   when CVD covers the same scale. But colorRiskRule can survive
 *   dedup, and those surviving issues deserve their own recommendations.
 *
 * Recommendation strategy:
 *
 *   We infer the scale context from the issue's `jsonPointer` and the
 *   spec, then offer the corresponding scheme-swap recommendations:
 *
 *     - Pointer in /encoding/<channel>/scale/range/N or /scheme
 *       → look at the channel's `type` field:
 *           nominal/ordinal → categorical recommendations
 *           quantitative/temporal → sequential recommendations
 *     - Pointer somewhere else (mark.fill, config.range)
 *       → no recommendations offered in this first cut.
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
 *   1. Walk the issue's pointer looking for `/encoding/<channel>/scale`.
 *   2. Read that channel's `type` field to determine categorical vs
 *      sequential vs diverging.
 *   3. Fall back to scheme name inference if `type` is missing.
 *
 * Returns 'unknown' when the pointer doesn't address a scale we can
 * recommend a swap for (e.g. mark.fill, config.range.category).
 */
function inferRiskContext(
  issue: AccessibilityIssue,
  spec: VegaLiteSpec,
): RiskContext {
  const pointer = issue.jsonPointer;
  if (!pointer) return {kind: 'unknown'};

  // Pointer examples we want to handle:
  //   /encoding/color/scale/range/0   (categorical range entry)
  //   /encoding/color/scale/scheme    (scheme reference)
  const segments = pointer.split('/').filter(Boolean);
  const scaleIdx = segments.indexOf('scale');
  if (scaleIdx === -1) return {kind: 'unknown'};

  // We need an /encoding/<channel>/scale prefix to look at the
  // channel's field type. Reject /config/range/... for now.
  if (segments[0] !== 'encoding' || scaleIdx < 2) return {kind: 'unknown'};

  const channel = segments[1];
  const scalePointer = '/' + segments.slice(0, scaleIdx + 1).join('/');

  const channelDef = (spec as any)?.encoding?.[channel];
  const fieldType = channelDef?.type;

  // Diverging signals on the scale block (mirror resolveScaleColors.ts).
  const scale = channelDef?.scale;
  const looksDiverging =
    scale?.type === 'diverging' ||
    (Array.isArray(scale?.domain) && scale.domain.length === 3) ||
    scale?.domainMid != null ||
    (typeof scale?.scheme === 'string' && findScheme(scale.scheme)?.type === 'diverging');

  if (looksDiverging) {
    return {kind: 'diverging-range', scalePointer};
  }

  if (fieldType === 'nominal' || fieldType === 'ordinal') {
    // Ordinal is technically ordered, but red+green pairings on
    // ordinal scales still mean categorical-looking fixes apply
    // (tableau10 etc. work fine for ordinal data).
    return {kind: 'categorical-range', scalePointer};
  }
  if (fieldType === 'quantitative' || fieldType === 'temporal') {
    return {kind: 'sequential-range', scalePointer};
  }

  // Last resort: infer from scheme name.
  if (typeof scale?.scheme === 'string') {
    const scheme = findScheme(scale.scheme);
    if (scheme?.type === 'sequential') return {kind: 'sequential-range', scalePointer};
    if (scheme?.type === 'categorical') return {kind: 'categorical-range', scalePointer};
  }

  return {kind: 'unknown'};
}

// ─── Helper factory ─────────────────────────────────────────────

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
      // Use the inferred scale pointer rather than parentPointer
      // because the issue pointer often addresses one element of a
      // range array — its parent is the range array, not the scale
      // object setScheme needs.
      const ctx = inferRiskContext(issue, spec);
      const scalePointer =
        ctx.kind === 'unknown' ? parentPointer(issue.jsonPointer) : ctx.scalePointer;
      return setScheme(spec, scalePointer, args.schemeName);
    },
  };
}

// ─── Categorical recommendations ────────────────────────────────

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

export const riskSwapToRedBlue = buildRiskSwap({
  id: 'risk-swap-to-redblue',
  label: 'Switch to redblue',
  description:
    'Classic diverging palette (red-white-blue). Reasonably CVD-safe.',
  schemeName: 'redblue',
  appliesToContext: (ctx) => ctx.kind === 'diverging-range',
});

// ─── Registry ────────────────────────────────────────────────────

export const colorRiskRecommendations: Recommendation[] = [
  // Categorical (most common case for red-green pairings)
  riskSwapToTableau10,
  riskSwapToSet2,
  riskSwapToObservable10,
  // Sequential
  riskSwapToViridis,
  riskSwapToCividis,
  // Diverging
  riskSwapToBlueOrange,
  riskSwapToRedBlue,
];