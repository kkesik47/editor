/**
 * contrastRule.ts
 *
 * Accessibility rule that checks WCAG 2.1 contrast requirements
 * for text and non-text elements in a Vega-Lite specification.
 *
 * Three checks, mapped to WCAG levels:
 *
 *   Level AA — WCAG 1.4.3 (Contrast – Minimum)
 *     Text elements (titles, axis labels, legend labels) must have
 *     a contrast ratio ≥ 4.5:1 against the background.
 *     Severity: 'warning' for author-set values, 'info' for defaults.
 *
 *   Level AA — WCAG 1.4.11 (Non-Text Contrast)
 *     Graphical elements (marks, scale colors) must have a contrast
 *     ratio ≥ 3:1 against the background.
 *     Severity: 'warning'.
 *     Only checked for categorical scales — sequential/diverging
 *     scales are handled by lightnessContrastRule instead.
 *
 *   Level AAA — WCAG 1.4.6 (Contrast – Enhanced)
 *     Text elements should have a contrast ratio ≥ 7:1.
 *     Severity: 'info' (suggestion, not mandatory).
 *
 * Architecture:
 *   1. contrastAnalysis.ts — resolve colors, compute ratios
 *   2. this file           — orchestrate and produce issues
 */

import type {AccessibilityIssue, AccessibilityRule} from '../types.js';
import {
  analyzeContrast,
  isLightBackground,
  TEXT_AA_THRESHOLD,
  TEXT_AAA_THRESHOLD,
  NON_TEXT_AA_THRESHOLD,
  type TextContrastEntry,
  type MarkContrastEntry,
  type ScaleContrastResult,
} from './contrastAnalysis.js';
import {WCAG_CONTRAST_MIN, WCAG_CONTRAST_ENHANCED, WCAG_NON_TEXT_CONTRAST} from '../references.js';

// ─── Issue builders ──────────────────────────────────────────────

/**
 * Build an issue for a text element that fails WCAG AA (< 4.5:1).
 *
 * Evidence includes `elementLabel` so the renderer can produce a
 * "sample text" preview showing the element's name (e.g. "X-axis
 * labels") rendered in the failing foreground color on the actual
 * background — letting the user see the legibility problem directly.
 */
function buildTextAAIssue(
  entry: TextContrastEntry,
  bg: string,
): AccessibilityIssue {
  const severity = entry.source === 'default' ? 'info' : 'warning';
  const sourceLabel =
    entry.source === 'default'
      ? 'Vega-Lite default'
      : entry.source === 'config'
        ? 'config block'
        : 'inline property';

  const direction = isLightBackground(bg) ? 'darker' : 'lighter';
  const section = entry.configKey.split('.')[0];

  return {
    ruleId: 'vl-a11y-contrast:text-aa',
    severity,

    message:
      `${entry.label} contrast ratio is ${entry.contrastRatio}:1 ` +
      `(${sourceLabel} color "${entry.foregroundColor}" against ` +
      `background "${bg}"), which is below the WCAG AA minimum ` +
      `of ${TEXT_AA_THRESHOLD}:1.`,

    suggestion:
      entry.source === 'default'
        ? `Set a text color with at least ${TEXT_AA_THRESHOLD}:1 contrast ` +
          `against your background in the ${section} configuration.`
        : `Use a ${direction} text color, or adjust the background ` +
          `to achieve at least ${TEXT_AA_THRESHOLD}:1 contrast.`,

    jsonPointer: entry.jsonPointer,
    references: [WCAG_CONTRAST_MIN],
    evidence: {
      wcagLevel: 'AA',
      wcagCriterion: '1.4.3',
      elementType: 'text',
      elementLabel: entry.label,
      foregroundColor: entry.foregroundColor,
      backgroundColor: bg,
      contrastRatio: entry.contrastRatio,
      threshold: TEXT_AA_THRESHOLD,
      source: entry.source,
    },
  };
}

/**
 * Build an issue for a text element that passes AA but fails AAA.
 *
 * This is a suggestion, not a requirement — the visualization is
 * already AA-compliant, but could be improved.
 */
function buildTextAAAIssue(
  entry: TextContrastEntry,
  bg: string,
): AccessibilityIssue {
  const direction = isLightBackground(bg) ? 'darker' : 'lighter';

  return {
    ruleId: 'vl-a11y-contrast:text-aaa',
    severity: 'info',

    message:
      `${entry.label} contrast ratio is ${entry.contrastRatio}:1, ` +
      `which meets WCAG AA (≥ ${TEXT_AA_THRESHOLD}:1) but not the ` +
      `enhanced AAA level (≥ ${TEXT_AAA_THRESHOLD}:1).`,

    suggestion:
      `For WCAG AAA compliance, use a ${direction} text color to ` +
      `achieve at least ${TEXT_AAA_THRESHOLD}:1 contrast against ` +
      `the background.`,

    jsonPointer: entry.jsonPointer,
    references: [WCAG_CONTRAST_ENHANCED],
    evidence: {
      wcagLevel: 'AAA',
      wcagCriterion: '1.4.6',
      elementType: 'text',
      elementLabel: entry.label,
      foregroundColor: entry.foregroundColor,
      backgroundColor: bg,
      contrastRatio: entry.contrastRatio,
      threshold: TEXT_AAA_THRESHOLD,
      source: entry.source,
    },
  };
}

/**
 * Build an issue for a mark/encoding color that fails non-text AA (< 3:1).
 *
 * Evidence includes `allColors` and `allRatios` (each as a single-
 * element array) so the renderer can reuse the scale-contrast preview
 * SVG to show one swatch on the background — visually consistent with
 * how multi-color scale issues are rendered.
 */
function buildMarkAAIssue(
  entry: MarkContrastEntry,
  bg: string,
): AccessibilityIssue {
  const direction = isLightBackground(bg) ? 'darker' : 'lighter';

  return {
    ruleId: 'vl-a11y-contrast:non-text-aa',
    severity: 'warning',

    message:
      `${entry.label} contrast ratio is ${entry.contrastRatio}:1 ` +
      `("${entry.foregroundColor}" against background "${bg}"), ` +
      `which is below the WCAG AA non-text minimum of ` +
      `${NON_TEXT_AA_THRESHOLD}:1.`,

    suggestion:
      `Use a ${direction} mark color, or adjust the background ` +
      `to achieve at least ${NON_TEXT_AA_THRESHOLD}:1 contrast.`,

    jsonPointer: entry.jsonPointer,
    references: [WCAG_NON_TEXT_CONTRAST],
    evidence: {
      wcagLevel: 'AA',
      wcagCriterion: '1.4.11',
      elementType: 'non-text',
      elementLabel: entry.label,
      foregroundColor: entry.foregroundColor,
      backgroundColor: bg,
      contrastRatio: entry.contrastRatio,
      threshold: NON_TEXT_AA_THRESHOLD,
      source: entry.source,
      // Wrap the single color into the same shape the scale preview
      // expects, so the renderer can reuse buildContrastPreviewSvg.
      allColors: [entry.foregroundColor],
      allRatios: [entry.contrastRatio],
    },
  };
}

/**
 * Build an issue for a color scale where some colors fail non-text AA.
 *
 * Groups all failing colors into a single issue per scale to avoid
 * flooding the problems panel with one issue per color.
 *
 * Includes allColors, allRatios and backgroundColor so the renderer
 * can build a visual preview showing each swatch on the background.
 */
function buildScaleAAIssue(
  result: ScaleContrastResult,
  bg: string,
): AccessibilityIssue {
  const count = result.failingColors.length;
  const schemeNote = result.schemeName
    ? ` (scheme '${result.schemeName}')`
    : '';

  return {
    ruleId: 'vl-a11y-contrast:non-text-aa',
    severity: 'warning',

    message:
      `${count} color${count > 1 ? 's' : ''} in the '${result.channel}' ` +
      `scale${schemeNote} ${count > 1 ? 'have' : 'has'} insufficient ` +
      `contrast against the background "${bg}" ` +
      `(worst ratio: ${result.worstRatio}:1, ` +
      `threshold: ${NON_TEXT_AA_THRESHOLD}:1).`,

    suggestion:
      `Choose scale colors with at least ${NON_TEXT_AA_THRESHOLD}:1 ` +
      `contrast against the background, or use a lighter/darker ` +
      `background color.`,

    jsonPointer: result.jsonPointer,

    evidence: {
      wcagLevel: 'AA',
      wcagCriterion: '1.4.11',
      elementType: 'non-text',
      backgroundColor: bg,
      threshold: NON_TEXT_AA_THRESHOLD,
      worstRatio: result.worstRatio,
      failingColors: result.failingColors,
      channel: result.channel,
      schemeName: result.schemeName ?? null,
      scaleType: 'categorical', // only categorical scales reach this builder; see checkScaleContrast in contrastAnalysis.ts
      // Data for the hover preview SVG
      allColors: result.allColors,
      allRatios: result.allRatios,
    },
  };
}

// ─── The rule ────────────────────────────────────────────────────

export const contrastRule: AccessibilityRule = {
  id: 'vl-a11y-contrast',

  description:
    'Checks WCAG 2.1 contrast ratios: text elements need ≥ 4.5:1 ' +
    '(AA) or ≥ 7:1 (AAA) against the background; non-text graphical ' +
    'elements need ≥ 3:1 (AA). Scale contrast is only checked for ' +
    'categorical scales.',
   references: [WCAG_CONTRAST_MIN, WCAG_CONTRAST_ENHANCED, WCAG_NON_TEXT_CONTRAST],
  evaluate(spec: Record<string, any>): AccessibilityIssue[] {
    const result = analyzeContrast(spec);
    const bg = result.backgroundColor;
    const issues: AccessibilityIssue[] = [];

    // ── Text contrast (AA and AAA) ──

    for (const entry of result.textEntries) {
      if (entry.contrastRatio < TEXT_AA_THRESHOLD) {
        // Fails AA — this is a problem
        issues.push(buildTextAAIssue(entry, bg));
      } else if (entry.contrastRatio < TEXT_AAA_THRESHOLD) {
        // Passes AA but fails AAA — this is a suggestion
        issues.push(buildTextAAAIssue(entry, bg));
      }
      // If ratio ≥ 7 → passes both AA and AAA, no issue
    }

    // ── Non-text contrast: marks (AA) ──

    for (const entry of result.markEntries) {
      if (entry.contrastRatio < NON_TEXT_AA_THRESHOLD) {
        issues.push(buildMarkAAIssue(entry, bg));
      }
    }

    // ── Non-text contrast: scales (AA, categorical only) ──

    for (const scaleResult of result.scaleResults) {
      issues.push(buildScaleAAIssue(scaleResult, bg));
    }

    return issues;
  },
};