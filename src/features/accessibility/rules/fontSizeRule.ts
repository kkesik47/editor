/**
 * fontSizeRule.ts
 *
 * Accessibility rule that checks whether text elements in a Vega-Lite
 * specification meet minimum font size thresholds for readability.
 *
 * Based on HCI research (Legge & Bigelow, 2011; Rello et al., 2016),
 * this rule adopts:
 *   - 16 px minimum for title-level elements (chart title, axis/legend titles)
 *   - 13 px minimum for label-level elements (axis tick labels, legend labels)
 *
 * Font sizes in Vega-Lite are always in pixels. The rule resolves the
 * effective size by checking inline properties → config block → Vega-Lite
 * defaults, then flags any element that falls below its threshold.
 *
 * Severity:
 *   - 'warning' when the author explicitly set a value that is too small
 *   - 'info'    when the Vega-Lite default is too small (gentle nudge)
 *
 * Editor visibility:
 *   - inline / config issues use 'underline' — the offending number is
 *     in the source, so we underline it directly.
 *   - default-source issues use 'underline-key' — the criticised value
 *     is NOT in the source (nothing is written), so the pointer is an
 *     anchor for the fix rather than the location of a value. We
 *     underline the property key (e.g. `"y"`, `"axis"`, `"title"`)
 *     instead of the value, which surfaces the issue in the editor
 *     without falsely marking unrelated sibling properties.
 *
 * Architecture:
 *   1. fontSizeAnalysis.ts — extract effective sizes and compare
 *   2. this file           — convert results into AccessibilityIssue objects
 */

import type {AccessibilityIssue, AccessibilityRule} from '../types.js';
import {
  analyzeFontSizes,
  type FontSizeEntry,
} from './fontSizeAnalysis.js';
import {LEGGE_BIGELOW_2011, RELLO_2016} from '../references.js';

// ─── Issue builder ───────────────────────────────────────────────

/**
 * Extract the JSON property name from a config key.
 * e.g. 'axis.labelFontSize' → 'labelFontSize'
 *      'title.fontSize'     → 'fontSize'
 */
function jsonPropertyName(configKey: string): string {
  const parts = configKey.split('.');
  return parts[parts.length - 1];
}

/**
 * Friendly name for where the property lives.
 * e.g. 'axis.labelFontSize' → 'axis'
 *      'title.fontSize'     → 'title'
 */
function configSectionName(configKey: string): string {
  return configKey.split('.')[0];
}

/**
 * Convert one FontSizeEntry into an AccessibilityIssue.
 *
 * Uses 'warning' severity for author-set values (they chose this)
 * and 'info' for Vega-Lite defaults (gentle nudge to configure).
 *
 * Default-source issues use 'underline-key' so the editor marks the
 * property key (e.g. `"y"`, `"axis"`, `"title"`) rather than the
 * whole value — see the file header for the rationale.
 */
function buildIssue(entry: FontSizeEntry): AccessibilityIssue {
  const isDefault = entry.source === 'default';
  const severity = isDefault ? 'info' : 'warning';

  const sourceLabel =
    entry.source === 'default'
      ? 'Vega-Lite default'
      : entry.source === 'config'
        ? 'config block'
        : 'inline property';

  const property = jsonPropertyName(entry.configKey);
  const section = configSectionName(entry.configKey);

  return {
    ruleId: `vl-a11y-font-size:${entry.configKey}`,
    severity,

    message:
      `${entry.label} font size is ${entry.effectiveSize} px ` +
      `(${sourceLabel}), which is below the recommended minimum ` +
      `of ${entry.threshold} px for ${entry.role === 'title' ? 'titles' : 'labels'}.`,

    suggestion:
      isDefault
        ? `Add "${property}": ${entry.threshold} to your ${section} configuration.`
        : `Increase "${property}" to at least ${entry.threshold}.`,

    jsonPointer: entry.jsonPointer,

    // Inline/config issues underline the offending number. Default
    // issues have no written value to point at, so we underline just
    // the property key instead — see the file header.
    editorVisibility: isDefault ? 'underline-key' : 'underline',

    evidence: {
      element: entry.label,
      configKey: entry.configKey,
      role: entry.role,
      effectiveSize: entry.effectiveSize,
      threshold: entry.threshold,
      source: entry.source,
    },
  };
}

// ─── The rule ────────────────────────────────────────────────────

export const fontSizeRule: AccessibilityRule = {
  id: 'vl-a11y-font-size',

  description:
    'Checks whether text elements (titles, axis labels, legend labels) ' +
    'meet minimum font size thresholds for readability. ' +
    'Titles require ≥ 16 px; labels require ≥ 13 px.',
  references: [LEGGE_BIGELOW_2011, RELLO_2016],
  evaluate(spec: Record<string, any>): AccessibilityIssue[] {
    const result = analyzeFontSizes(spec);
    return result.issues.map(buildIssue);
  },
};