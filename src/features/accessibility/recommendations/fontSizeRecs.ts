/**
 * recommendations/fontSizeRecs.ts
 *
 * Recommendations for issues from `fontSizeRule`
 * (readability minimums: 16 px titles, 13 px labels).
 *
 * Unlike the colour rules, font size has essentially no trade-off
 * space: the fix is "make it at least the recommended minimum". So
 * each issue gets a single recommendation that bumps the size up to
 * its threshold - the smallest change that satisfies the guideline,
 * which also minimises the risk of crowding dense tick labels or
 * widening the chart. We deliberately do NOT offer a larger
 * "comfortable" value, to avoid manufacturing a trade-off that isn't
 * really there.
 *
 * There are two recommendation objects (one for titles, one for
 * labels) purely so each can carry a correct static label ("Increase
 * to 16 px" / "Increase to 13 px"). Exactly one applies to any given
 * issue, because every font-size issue is either a title or a label.
 *
 * ─── Where the fix is written (determined by issue.source) ───────
 *
 * The author doesn't choose the location - it's dictated by where the
 * too-small value lives, mirroring how Vega-Lite resolves sizes
 * (inline overrides config overrides default):
 *
 *   inline  → the issue pointer addresses the number itself
 *             (e.g. /encoding/x/axis/labelFontSize). Replace it in
 *             place. A config-level fix wouldn't help - the inline
 *             value would still override it.
 *
 *   config  → the issue pointer addresses the config number
 *             (e.g. /config/axis/labelFontSize). Replace it in place.
 *
 *   default → nothing is set yet; the pointer addresses the channel
 *             or the axis/legend object. We write
 *             config.<section>.<property> instead. This is both the
 *             cleanest edit and the most robust: it works even when
 *             there's no axis/legend block to nest into, and even
 *             when the title is a bare string ("title": "Chart")
 *             where you can't add a fontSize property inside.
 */

import type {AccessibilityIssue} from '../types.js';
import type {Recommendation} from './types.js';
import {setValueAt, setConfigProperty} from './specMutators.js';

// ─── Threshold constants ─────────────────────────────────────────
//
// Mirror TITLE_FONT_SIZE_THRESHOLD / LABEL_FONT_SIZE_THRESHOLD in
// fontSizeAnalysis.ts. Kept as a local copy so the recommendations
// module stays decoupled from the rule's internals (same approach as
// the mark lists in colorOnlyEncodingRecs.ts). If the rule's
// thresholds change, update these too.

const TITLE_MIN_PX = 16;
const LABEL_MIN_PX = 13;

// ─── Evidence reader ─────────────────────────────────────────────

interface FontSizeEvidence {
  /** e.g. "axis.labelFontSize", "title.fontSize". */
  configKey: string;
  /** Title-level vs label-level element (selects the threshold). */
  role: 'title' | 'label';
  /** Where the current value comes from - decides where the fix goes. */
  source: 'inline' | 'config' | 'default';
}

function readFontSizeEvidence(issue: AccessibilityIssue): FontSizeEvidence | null {
  const e = issue.evidence as Record<string, unknown> | null | undefined;
  if (!e || typeof e !== 'object') return null;

  const {configKey, role, source} = e;
  if (typeof configKey !== 'string') return null;
  if (role !== 'title' && role !== 'label') return null;
  if (source !== 'inline' && source !== 'config' && source !== 'default') {
    return null;
  }

  return {configKey, role, source};
}

// ─── configKey helpers ───────────────────────────────────────────
//
// "axis.labelFontSize" → section "axis", property "labelFontSize"
// "title.fontSize"     → section "title", property "fontSize"

function configSection(configKey: string): string {
  return configKey.split('.')[0];
}

function configProperty(configKey: string): string {
  const parts = configKey.split('.');
  return parts[parts.length - 1];
}

// ─── Helper factory ─────────────────────────────────────────────

/**
 * Build a "bump the size to the minimum" recommendation for one role.
 *
 * `appliesToRole` gates the recommendation so only the title rec
 * shows on title issues and only the label rec shows on label issues.
 * `targetSize` is the role's minimum (16 or 13).
 *
 * The apply writes to the source-appropriate location:
 *   inline / config → replace the number the pointer addresses
 *   default         → set config.<section>.<property>
 */
function buildFontSizeBump(args: {
  id: string;
  label: string;
  description: string;
  role: 'title' | 'label';
  targetSize: number;
}): Recommendation {
  return {
    id: args.id,
    label: args.label,
    description: args.description,
    family: 'adjustment',

    applicableWhen(issue) {
      const evidence = readFontSizeEvidence(issue);
      if (!evidence) return false;
      return evidence.role === args.role;
    },

    apply(issue, spec) {
      const evidence = readFontSizeEvidence(issue);
      if (!evidence) return spec;

      // inline & config: the pointer is the number - replace it.
      if (evidence.source === 'inline' || evidence.source === 'config') {
        return setValueAt(spec, issue.jsonPointer, args.targetSize);
      }

      // default: nothing set yet - write it into config, which is
      // robust to missing axis/legend blocks and string titles.
      return setConfigProperty(
        spec,
        configSection(evidence.configKey),
        configProperty(evidence.configKey),
        args.targetSize,
      );
    },
  };
}

// ─── Recommendations ─────────────────────────────────────────────

export const increaseTitleFontSize = buildFontSizeBump({
  id: 'font-size-increase-title',
  label: `Increase to ${TITLE_MIN_PX} px`,
  description:
    `Raises the text to the ${TITLE_MIN_PX} px minimum recommended for ` +
    'titles. If a value is already set, it is updated in place; ' +
    'otherwise the size is added to the chart configuration.',
  role: 'title',
  targetSize: TITLE_MIN_PX,
});

export const increaseLabelFontSize = buildFontSizeBump({
  id: 'font-size-increase-label',
  label: `Increase to ${LABEL_MIN_PX} px`,
  description:
    `Raises the text to the ${LABEL_MIN_PX} px minimum recommended for ` +
    'labels. If a value is already set, it is updated in ' +
    'place; otherwise the size is added to the chart configuration.',
  role: 'label',
  targetSize: LABEL_MIN_PX,
});

// ─── Registry ────────────────────────────────────────────────────

export const fontSizeRecommendations: Recommendation[] = [increaseTitleFontSize, increaseLabelFontSize];
