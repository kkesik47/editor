/**
 * recommendations/contrastRecs.ts
 *
 * Recommendations for issues from `contrastRule`
 * (WCAG 2.1 – 1.4.3 text AA, 1.4.6 text AAA, 1.4.11 non-text AA).
 *
 * Contrast is fundamentally a RELATIONSHIP between a foreground and a
 * background, so every failure can be fixed from either end. That's
 * the real trade-off, surfaced as named options instead of silently
 * picking one.
 *
 * Three issue shapes from the rule:
 *
 *   vl-a11y-contrast:text-aa     text fails 4.5:1 (warning, or info if default)
 *   vl-a11y-contrast:text-aaa    text passes AA but misses 7:1 (info)
 *   vl-a11y-contrast:non-text-aa mark OR scale color fails 3:1 (warning)
 *
 * The non-text-aa issue comes in two flavours, distinguished by the
 * shape of evidence:
 *
 *   Single-mark flavour  - allColors.length === 1
 *     Same trade-off as text: nudge fg vs. change bg.
 *
 *   Scale flavour        - allColors.length > 1, failingColors present
 *     No single foreground to nudge. Trade-off becomes:
 *       "Switch to a contrast-safe palette" (keeps bg, drops palette)
 *     vs
 *       "Change background" (keeps palette, drops original bg).
 *
 * One registry entry `'vl-a11y-contrast'` covers all three sub-keys
 * via prefix matching.
 *
 * ─── Notes on what's NOT covered ─────────────────────────────────
 *
 *   Sequential / diverging scale contrast: the rule deliberately
 *   skips these (see checkScaleContrast in contrastAnalysis.ts) on
 *   the grounds that gradient colors don't stand alone. So this
 *   file's palette-swap rec only offers CATEGORICAL alternatives;
 *   sequential/diverging candidates were removed in v2 since they
 *   were unreachable. If/when the rule's scope expands to gradients,
 *   the candidate list here should expand to match.
 */

import type {AccessibilityIssue} from '../types.js';
import type {Recommendation, VegaLiteSpec} from './types.js';
import {setValueAt, setConfigProperty, setScheme, replaceColorInRange, parentPointer} from './specMutators.js';
import {
  adjustForegroundUntilRatio,
  findContrastSafeSchemes,
  pickSafeBackgroundFor,
  pickTextColorFor,
} from './contrastAdjust.js';
import type {SchemeType} from './schemeCatalog.js';

// ─── Evidence reader ─────────────────────────────────────────────

interface ContrastEvidence {
  /** WCAG criterion level - drives AA vs AAA thresholds. */
  wcagLevel: 'AA' | 'AAA';
  /** 'text' for text issues, 'non-text' for mark/scale issues. */
  elementType: 'text' | 'non-text';
  /** Resolved foreground color (single-mark and text issues only). */
  foregroundColor: string | null;
  backgroundColor: string;
  contrastRatio: number | null;
  threshold: number;
  /** Inline / config / default - drives where text fixes are written. */
  source: 'inline' | 'config' | 'default' | null;
  /** Element label, e.g. "X-axis labels" - used in some descriptions. */
  elementLabel: string | null;
  /**
   * For scale-flavour non-text issues: the list of colors in the
   * scale. Length > 1 means "scale flavour"; length === 1 means
   * single-mark flavour. Absent for text issues.
   */
  allColors: string[] | null;
  /**
   * Only present on the scale flavour: the subset of allColors that
   * actually fall below the threshold. The "change background" rec
   * optimises against THESE specifically (not against the whole
   * palette), per the v2 design decision.
   */
  failingColors: string[] | null;
  /**
   * Same failing colors as `failingColors`, paired with their index
   * in the scale's color list so a per-color fix can edit the right
   * slot in `scale.range`. Scale flavour only.
   */
  failingEntries: {color: string; index: number}[] | null;
  /** Scale channel ('color' / 'fill' / 'stroke') for scale issues. */
  channel: string | null;
  /** Existing scheme name on the failing scale, if any. */
  schemeName: string | null;
  /**
   * Scale type ('categorical' / 'sequential' / 'diverging'), added in
   * v2 so the palette-swap rec can find candidates of the right type.
   * Null on text and single-mark issues.
   */
  scaleType: SchemeType | null;
}

function readContrastEvidence(issue: AccessibilityIssue): ContrastEvidence | null {
  const e = issue.evidence as Record<string, unknown> | null | undefined;
  if (!e || typeof e !== 'object') return null;

  const wcagLevel = e.wcagLevel;
  if (wcagLevel !== 'AA' && wcagLevel !== 'AAA') return null;

  const elementType = e.elementType;
  if (elementType !== 'text' && elementType !== 'non-text') return null;

  const backgroundColor = e.backgroundColor;
  if (typeof backgroundColor !== 'string') return null;

  const threshold = e.threshold;
  if (typeof threshold !== 'number') return null;

  // failingColors on the scale flavour is an array of
  // {color, ratio, index}. Keep the index alongside each color so a
  // per-color fix can edit the right slot in scale.range; the bare
  // color strings are derived from it for consumers that only need those.
  const failingRaw = e.failingColors;
  let failingEntries: {color: string; index: number}[] | null = null;
  if (Array.isArray(failingRaw)) {
    failingEntries = failingRaw
      .map((entry) => {
        const r = (entry as Record<string, unknown>) ?? {};
        return {color: r.color, index: r.index};
      })
      .filter((x): x is {color: string; index: number} => typeof x.color === 'string' && typeof x.index === 'number');
  }
  const failingColors = failingEntries ? failingEntries.map((x) => x.color) : null;

  const scaleTypeRaw = e.scaleType;
  const scaleType =
    scaleTypeRaw === 'categorical' || scaleTypeRaw === 'sequential' || scaleTypeRaw === 'diverging'
      ? scaleTypeRaw
      : null;

  return {
    wcagLevel,
    elementType,
    foregroundColor: typeof e.foregroundColor === 'string' ? e.foregroundColor : null,
    backgroundColor,
    contrastRatio: typeof e.contrastRatio === 'number' ? e.contrastRatio : null,
    threshold,
    source: e.source === 'inline' || e.source === 'config' || e.source === 'default' ? e.source : null,
    elementLabel: typeof e.elementLabel === 'string' ? e.elementLabel : null,
    allColors: Array.isArray(e.allColors)
      ? (e.allColors as unknown[]).filter((c): c is string => typeof c === 'string')
      : null,
    failingColors,
    failingEntries,
    channel: typeof e.channel === 'string' ? e.channel : null,
    schemeName: typeof e.schemeName === 'string' ? e.schemeName : null,
    scaleType,
  };
}

// ─── Issue-shape predicates ─────────────────────────────────────

function isTextIssue(ev: ContrastEvidence): boolean {
  return ev.elementType === 'text';
}

function isSingleMarkIssue(ev: ContrastEvidence): boolean {
  return ev.elementType === 'non-text' && (ev.allColors == null || ev.allColors.length <= 1);
}

function isScaleIssue(ev: ContrastEvidence): boolean {
  return ev.elementType === 'non-text' && ev.allColors != null && ev.allColors.length > 1;
}

// ─── The set of colors that are actually failing ───────────────

/**
 * Which color(s) the "Change background" rec needs to optimise
 * against. For text and single-mark issues this is the lone
 * foreground. For scale issues it's the subset that fell below the
 * threshold - passing colors in the same scale don't need help and
 * shouldn't influence the choice of extreme.
 *
 * Returns an empty array when nothing is identifiable as failing,
 * which causes the rec to drop out via applicableWhen.
 */
function failingForegroundsFor(ev: ContrastEvidence): string[] {
  if (isScaleIssue(ev)) return ev.failingColors ?? [];
  return ev.foregroundColor ? [ev.foregroundColor] : [];
}

// ─── Foreground fix helpers ─────────────────────────────────────

/**
 * Write a new foreground color at the issue's source-appropriate
 * location, mirroring how fontSizeRecs decides between in-place
 * replacement and config write.
 *
 *   inline  → replace the value the pointer addresses
 *   config  → replace the value the pointer addresses (config block)
 *   default → write to config.<section>.<property>, derived from the
 *             element label. Robust to missing axis/legend blocks
 *             and to string-form titles.
 */
function writeForeground(
  spec: VegaLiteSpec,
  issue: AccessibilityIssue,
  ev: ContrastEvidence,
  newColor: string,
): VegaLiteSpec {
  if (ev.source === 'inline' || ev.source === 'config') {
    return setValueAt(spec, issue.jsonPointer, newColor);
  }

  // Default source: figure out the right config target from the
  // element label. The rule's checkers all set elementLabel to one
  // of a small fixed set ("Chart title", "X-axis labels", etc.),
  // and the label cleanly tells us section + property.
  const target = configTargetForLabel(ev.elementLabel);
  if (!target) {
    // Unknown label shape - fall back to writing at the pointer,
    // which addresses the channel or axis/legend object. Not ideal,
    // but never destructive.
    return setValueAt(spec, issue.jsonPointer, newColor);
  }
  return setConfigProperty(spec, target.section, target.property, newColor);
}

/**
 * Map an element label back to its config target.
 *
 * Mirrors the labels set in `contrastAnalysis.ts`. Single source of
 * truth would be nicer, but the labels live on the analysis side
 * and we don't want this module importing analysis internals.
 */
function configTargetForLabel(label: string | null): {section: string; property: string} | null {
  if (!label) return null;
  if (label === 'Chart title') return {section: 'title', property: 'color'};
  if (label.endsWith('axis labels')) return {section: 'axis', property: 'labelColor'};
  if (label.endsWith('axis title')) return {section: 'axis', property: 'titleColor'};
  if (label.endsWith('legend labels')) return {section: 'legend', property: 'labelColor'};
  if (label.endsWith('legend title')) return {section: 'legend', property: 'titleColor'};
  return null;
}

/**
 * Pure black/white text choice, decided by which extreme gives the
 * better contrast against the background.
 *
 * Black wins on light backgrounds, white wins on dark ones. The old
 * `isLightBackground(bg)` test gave the same answer for typical
 * backgrounds, but this phrasing is honest about WHY: we're choosing
 * the extreme that yields the higher contrast ratio.
 */
function blackOrWhiteText(bg: string): '#000000' | '#ffffff' {
  return pickTextColorFor(bg);
}

// ─── Helper factory for the foreground-nudge rec ─────────────────

/**
 * Build the "adjust foreground" rec for one of two flavours:
 *
 *   text       - applies to text-AA and text-AAA issues
 *   singleMark - applies to single-mark non-text-AA issues
 *
 * Split because the user-facing language differs ("text" vs "mark"),
 * not because the mechanics differ - both share the same OKLCH
 * lightness nudge and the same writeForeground path.
 */
function buildAdjustForegroundRec(args: {
  id: string;
  label: string;
  description: string;
  applies: (ev: ContrastEvidence) => boolean;
}): Recommendation {
  return {
    id: args.id,
    label: args.label,
    description: args.description,
    family: 'adjustment',

    applicableWhen(issue) {
      const ev = readContrastEvidence(issue);
      if (!ev || !args.applies(ev)) return false;
      if (!ev.foregroundColor) return false;

      // Don't offer if we can't actually reach the target - degenerate
      // cases (near-extreme fg against same-toned bg).
      const adjusted = adjustForegroundUntilRatio(ev.foregroundColor, ev.backgroundColor, ev.threshold);
      return adjusted != null;
    },

    apply(issue, spec) {
      const ev = readContrastEvidence(issue);
      if (!ev || !ev.foregroundColor) return spec;

      const adjusted = adjustForegroundUntilRatio(ev.foregroundColor, ev.backgroundColor, ev.threshold);
      if (!adjusted) return spec;

      return writeForeground(spec, issue, ev, adjusted);
    },
  };
}

// ─── Recommendations: foreground nudge (text and mark) ──────────

export const adjustTextLightness = buildAdjustForegroundRec({
  id: 'contrast-adjust-text',
  label: 'Adjust the text color',
  description:
    'Keeps the background as it is and shifts the text color just ' +
    'enough to meet the contrast threshold. Hue is preserved so the ' +
    "color's identity is kept; only its lightness changes. The " +
    'lightest possible touch - only affects the failing element.',
  applies: isTextIssue,
});

export const adjustMarkLightness = buildAdjustForegroundRec({
  id: 'contrast-adjust-mark',
  label: 'Adjust the mark color',
  description:
    'Keeps the background as it is and shifts the mark color just ' +
    'enough to meet the contrast threshold. Hue is preserved so the ' +
    "color's identity is kept; only its lightness changes. The " +
    'lightest possible touch - only affects the failing mark.',
  applies: isSingleMarkIssue,
});

// ─── Recommendation: adjust the failing scale color(s) ─────────

/**
 * "Adjust the failing colors" - the scale-flavour counterpart to
 * adjustMarkLightness. Keeps the background and every PASSING color
 * untouched, and nudges only the color(s) that fall below the
 * threshold until they clear it. Hue is preserved (OKLCH lightness
 * shift), so each adjusted color keeps its identity.
 *
 * This is the targeted alternative to "Change the background": it
 * fixes the failing element without a global change, and without
 * dropping the author's palette the way a scheme swap would.
 *
 * Only offered when EVERY failing color can actually reach the
 * target ratio, so applying it fully resolves the issue instead of
 * leaving some colors still failing.
 */
export const adjustScaleColors: Recommendation = {
  id: 'contrast-adjust-scale-colors',
  label: 'Adjust the failing colors',
  description:
    'Keeps the background and every passing color, and shifts only ' +
    'the color(s) below the contrast threshold just enough to clear ' +
    'it. Hue is preserved - only lightness changes - so each color ' +
    'keeps its identity. The most targeted fix for a palette, since ' +
    'the rest of the colors are left exactly as they are.',
  family: 'adjustment',

  applicableWhen(issue) {
    const ev = readContrastEvidence(issue);
    if (!ev || !isScaleIssue(ev)) return false;

    const failing = ev.failingEntries ?? [];
    if (failing.length === 0) return false;

    // Only offer if every failing color can actually reach the target;
    // otherwise applying this would leave the warning partly in place.
    return failing.every((f) => adjustForegroundUntilRatio(f.color, ev.backgroundColor, ev.threshold) != null);
  },

  apply(issue, spec) {
    const ev = readContrastEvidence(issue);
    if (!ev) return spec;

    const failing = ev.failingEntries ?? [];
    // The pointer addresses scale.range (or scale.scheme); its parent
    // is the scale object - the shape replaceColorInRange expects.
    const scalePointer = parentPointer(issue.jsonPointer);
    const fallback = ev.allColors ?? [];

    // Edit each failing slot in turn. allColors is passed as the
    // fallback so a scheme-based scale is materialised to an explicit
    // range before the color is replaced.
    let next = spec;
    for (const f of failing) {
      const adjusted = adjustForegroundUntilRatio(f.color, ev.backgroundColor, ev.threshold);
      if (!adjusted) continue; // guarded by applicableWhen
      next = replaceColorInRange(next, scalePointer, f.index, adjusted, fallback);
    }
    return next;
  },
};

// ─── Recommendations: pure black/white text ─────────────────────

/**
 * "Use black/white text" - text-only nuclear option. Guarantees
 * maximum contrast against the background by snapping to whichever
 * extreme works. Sacrifices any color the text had.
 *
 * Only offered for text issues (a mark snapped to pure black/white
 * isn't usually meaningful).
 */
export const useBlackOrWhiteText: Recommendation = {
  id: 'contrast-use-black-or-white-text',
  label: 'Use black or white text',
  description:
    'Sets the text to the color with the strongest possible contrast ' +
    'against the background (black on a light background, white on a ' +
    'dark one). Guaranteed to pass, but loses any color the text had.',
  family: 'adjustment',

  applicableWhen(issue) {
    const ev = readContrastEvidence(issue);
    if (!ev) return false;
    return isTextIssue(ev) && ev.foregroundColor != null;
  },

  apply(issue, spec) {
    const ev = readContrastEvidence(issue);
    if (!ev) return spec;
    const replacement = blackOrWhiteText(ev.backgroundColor);
    return writeForeground(spec, issue, ev, replacement);
  },
};

// ─── Recommendations: change background ─────────────────────────

/**
 * "Change background" - keeps every foreground color and adjusts the
 * background instead. Snaps to whichever extreme (white or near-
 * black) maximises the minimum contrast against the failing
 * foreground(s).
 *
 * Applies to all three issue shapes - text, single-mark, AND scale -
 * because in every case the relationship can be fixed from this side.
 *
 * v2 fix: the picker is now driven by the failing FOREGROUNDS, not
 * the current background. Previously a near-black scale on a black
 * background would snap to near-black, lowering contrast further; now
 * it correctly snaps to white. For scale issues, the optimisation
 * considers ONLY the colors that actually failed - passing colors
 * in the same scale don't need help and shouldn't drag the choice.
 */
export const changeBackground: Recommendation = {
  id: 'contrast-change-background',
  label: 'Change the background',
  description:
    'Keeps every foreground color and switches the background to the ' +
    'extreme (white or near-black) that maximises contrast for the ' +
    'failing element. Fixes the failure without touching element ' +
    'colors, but is a global change and may affect other parts of ' +
    'the chart.',
  family: 'adjustment',

  applicableWhen(issue) {
    const ev = readContrastEvidence(issue);
    if (!ev) return false;

    const failing = failingForegroundsFor(ev);
    if (failing.length === 0) return false;

    const target = pickSafeBackgroundFor(failing);
    if (!target) return false;

    // Don't offer if the safe target equals the current background -
    // would be a no-op edit.
    return ev.backgroundColor.toLowerCase() !== target.toLowerCase();
  },

  apply(issue, spec) {
    const ev = readContrastEvidence(issue);
    if (!ev) return spec;

    const failing = failingForegroundsFor(ev);
    const target = pickSafeBackgroundFor(failing);
    if (!target) return spec;

    // Write at top-level `background` - simplest, most visible, and
    // takes precedence over config.background / config.view.fill.
    return setValueAt(spec, '/background', target);
  },
};

// ─── Recommendations: switch to a contrast-safe palette ─────────
//
// Scale-only. Each candidate scheme is a separate Recommendation; the
// generator emits one per name and `applicableWhen` checks safety at
// decision time using the current background and category count.
//
// Sequential / diverging candidates are intentionally OMITTED from
// the candidate list. The rule itself only flags categorical scales
// for contrast (sequential gradients are skipped by design), so any
// sequential candidate here would be unreachable. If the rule's
// scope is later extended to gradients, expand this list and update
// the file-header note.

function buildSchemeSwapRec(args: {schemeName: string; schemeType: SchemeType; schemeNotes: string}): Recommendation {
  return {
    id: `contrast-swap-to-${args.schemeName}`,
    label: `Switch to ${args.schemeName}`,
    description:
      `Replaces the failing palette with the ${args.schemeName} scheme, ` +
      `which is contrast-safe against the current background. ${args.schemeNotes}`,
    family: 'replacement',

    applicableWhen(issue) {
      const ev = readContrastEvidence(issue);
      if (!ev || !isScaleIssue(ev)) return false;

      // Without scaleType we can't query candidates of the right type;
      // bail rather than guess and offer something that doesn't fit.
      if (ev.scaleType !== args.schemeType) return false;

      // Re-check at decision time: only offer if THIS scheme is still
      // safe given the current background and category count.
      const safe = findContrastSafeSchemes({
        background: ev.backgroundColor,
        scaleType: args.schemeType,
        targetRatio: ev.threshold,
        categoryCount: ev.allColors?.length,
        excludeSchemeName: ev.schemeName,
      });
      return safe.some((s) => s.name === args.schemeName);
    },

    apply(issue, spec) {
      // The pointer addresses the scale.range or scale.scheme; its
      // parent is the scale object - same shape colorblindSafetyRecs
      // and colorRiskRecs use.
      return setScheme(spec, parentPointer(issue.jsonPointer), args.schemeName);
    },
  };
}

function getContrastSafePaletteRecommendations(): Recommendation[] {
  // Categorical only (see comment block above). The list mirrors the
  // most familiar / most-recommended palettes in colorblindSafetyRecs
  // so authors who have seen one set are not surprised by the other.
  const candidates: {name: string; type: SchemeType; notes: string}[] = [
    {name: 'tableau10', type: 'categorical', notes: "Tableau's standard categorical palette."},
    {name: 'dark2', type: 'categorical', notes: 'Higher-saturation ColorBrewer categorical palette.'},
    {name: 'set2', type: 'categorical', notes: 'Muted ColorBrewer categorical palette.'},
    {name: 'observable10', type: 'categorical', notes: "Observable's default categorical palette."},
  ];

  return candidates.map((c) =>
    buildSchemeSwapRec({
      schemeName: c.name,
      schemeType: c.type,
      schemeNotes: c.notes,
    }),
  );
}

// ─── Registry ────────────────────────────────────────────────────

export const contrastRecommendations: Recommendation[] = [
  // Foreground-side fixes
  adjustTextLightness,
  adjustMarkLightness,
  adjustScaleColors,
  useBlackOrWhiteText,
  // Background-side fix (applies to all three issue shapes)
  changeBackground,
  // Scale-only: palette swap. Each candidate is its own rec, gated
  // by `applicableWhen` to only appear when safe.
  ...getContrastSafePaletteRecommendations(),
];
