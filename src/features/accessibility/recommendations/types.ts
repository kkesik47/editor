/**
 * recommendations/types.ts
 *
 * Core types for the trade-off-aware recommendation engine.
 *
 * A Recommendation is a concrete, machine-applicable way to address
 * an accessibility issue. Each rule may have several recommendations
 * per issue, representing different trade-offs an author might make:
 *
 *   - replacement  - swap in a better-by-default value (e.g. viridis)
 *   - adjustment   - tune the existing value just enough (e.g. nudge L*)
 *   - redundancy   - add another channel so the broken one matters less
 *   - augmentation - add an outline/halo without changing colors
 *   - restructure  - change the encoding type (e.g. quantize)
 *
 * Authors pick based on what they want to preserve (palette, mark
 * type, design intent). The engine surfaces all applicable options -
 * it doesn't choose for the author.
 */

import type {AccessibilityIssue} from '../types.js';

/**
 * Convenience alias used throughout the recommendations module.
 * Matches the parameter type used by `colorblindSafetyRule.evaluate`
 * and the other strict rules.
 */
export type VegaLiteSpec = Record<string, unknown>;

/**
 * Family classification for a recommendation, used in writeups and
 * (eventually) for grouping in the UI. Not currently displayed -
 * present so each recommendation declares its strategic intent
 * for documentation purposes.
 */
export type RecommendationFamily = 'replacement' | 'adjustment' | 'redundancy' | 'augmentation' | 'restructure';

export interface Recommendation {
  /** Stable identifier, e.g. 'cvd-swap-sequential-scheme'. */
  id: string;

  /** Short user-facing name shown as the button label. */
  label: string;

  /**
   * One-line trade-off description shown beneath the label.
   * Explains what the recommendation preserves and what it sacrifices,
   * so authors can choose based on their priorities.
   */
  description: string;

  /** Which strategy family this belongs to (see RecommendationFamily). */
  family: RecommendationFamily;

  /**
   * Returns true when this recommendation can sensibly be applied to
   * the given issue in the given spec. Used by the UI to filter out
   * recommendations that don't fit the current context - e.g. "add
   * shape encoding" is not applicable to bar charts.
   */
  applicableWhen: (issue: AccessibilityIssue, spec: VegaLiteSpec) => boolean;

  /**
   * Returns a NEW spec with the recommendation applied.
   * The original spec is not mutated - mutators deep-clone before editing.
   */
  apply: (issue: AccessibilityIssue, spec: VegaLiteSpec) => VegaLiteSpec;
}
