/**
 * recommendations/perceptualUniformityRecs.ts
 *
 * Recommendations for issues from `perceptualUniformityRule`.
 *
 * The rule fires when an ordered (sequential / diverging) color scale
 * has uneven perceptual steps - equal data intervals producing unequal
 * visible color changes (the classic rainbow problem). The
 * machine-applicable fix is to swap the scale for a perceptually
 * uniform scheme, via `setScheme` (which drops any explicit `range`).
 * Same shape as the scale-swap recs in colorblindSafetyRecs /
 * lightnessContrastRecs / contrastRecs.
 *
 * ─── Type isolation ─────────────────────────────────────────────
 *
 * Sequential issues only surface sequential recs, and diverging
 * issues only surface diverging recs. This is enforced twice and
 * cannot leak:
 *
 *   1. Each Candidate has a static `type` field ('sequential' or
 *      'diverging'). `applicableWhen` returns false up front when
 *      `ev.scaleType !== candidate.type`.
 *   2. `findUniformSchemes` itself filters SCHEME_CATALOG by the
 *      issue's scaleType, so its result set never contains a
 *      cross-type scheme.
 *
 * ─── Candidate list ─────────────────────────────────────────────
 *
 * Hand-picked so each rec earns its slot for a distinct reason
 * (general default / CVD-equivalence / warm / grayscale-print, and
 * analogously for diverging). Avoids overwhelming the pane while
 * still covering the common "preserve the feel" cases.
 *
 * Each candidate is gated by `applicableWhen`:
 *   - scale shape matches,
 *   - not the scheme already in use,
 *   - and ACTUALLY passes the uniformity check via
 *     `findUniformSchemes` - so we never recommend a "fix" that
 *     would just re-trigger the same rule.
 *
 * ─── On the dropped rainbow → turbo recommendation ──────────────
 *
 * An earlier iteration offered turbo as a "preserve the rainbow look
 * but fix uniformity" option for rainbow / sinebow originals.
 * Empirical testing showed turbo's CV at the rule's sampling density
 * is not meaningfully better than the rainbow input in our pipeline,
 * so recommending it would be dishonest - the rec was removed rather
 * than papered over with a threshold bypass. Detecting rainbow-likeness
 * from custom `range` arrays is also non-trivial, so a future
 * "preserve hue feel" rec for arbitrary input would need separate work.
 *
 * Re-spacing a custom `range` in place (an adjustment-family fix that
 * keeps the author's own colors but resamples them to equal ΔE steps)
 * is still left for a later pass.
 */

import type {AccessibilityIssue} from '../types.js';
import type {Recommendation} from './types.js';
import {setScheme, parentPointer} from './specMutators.js';
import {findUniformSchemes, type OrderedScaleType} from './perceptualUniformityAdjust.js';

// ─── Evidence reader ─────────────────────────────────────────────

interface UniformityEvidence {
  /** Only 'sequential' / 'diverging' reach here - the rule skips categorical. */
  scaleType: OrderedScaleType;
  /** Original scheme name, or null when the scale uses an explicit range. */
  schemeName: string | null;
}

function readUniformityEvidence(issue: AccessibilityIssue): UniformityEvidence | null {
  const e = issue.evidence as Record<string, unknown> | null | undefined;
  if (!e || typeof e !== 'object') return null;

  const scaleType = e.scaleType;
  if (scaleType !== 'sequential' && scaleType !== 'diverging') return null;

  const schemeName = typeof e.schemeName === 'string' ? e.schemeName : null;
  return {scaleType, schemeName};
}

/** Same-scheme check, tolerant of discrete suffixes like "viridis-9". */
function isSameScheme(schemeName: string | null, candidate: string): boolean {
  if (!schemeName) return false;
  return schemeName.toLowerCase().replace(/-\d+$/, '') === candidate;
}

// ─── Candidate definitions ───────────────────────────────────────

interface Candidate {
  /** Vega scheme name (also the catalogue key and the applied value). */
  name: string;
  /** Which scale shape this candidate is a fix for. */
  type: OrderedScaleType;
  /** Trade-off description shown under the button. */
  description: string;
}

const SEQUENTIAL_CANDIDATES: Candidate[] = [
  {
    name: 'viridis',
    type: 'sequential',
    description:
      'Perceptually uniform: equal data steps produce equal visual ' +
      'changes. Strong neutral default - grayscale-readable and ' +
      'colorblind-safe.',
  },
  {
    name: 'cividis',
    type: 'sequential',
    description:
      'Perceptually uniform, designed so colorblind and ' + 'non-colorblind viewers see nearly the same scale.',
  },
  {
    name: 'magma',
    type: 'sequential',
    description: 'Perceptually uniform, dark-purple → orange → yellow. Best for ' + 'keeping a warm look.',
  },
  {
    name: 'greys',
    type: 'sequential',
    description: 'Neutral grayscale. The most robust option for print and for ' + 'any color vision deficiency.',
  },
];

const DIVERGING_CANDIDATES: Candidate[] = [
  {
    name: 'blueorange',
    type: 'diverging',
    description:
      'Even color steps on each side of the midpoint; the blue–orange ' +
      'axis also stays distinct for most colorblind viewers.',
  },
  {
    name: 'redblue',
    type: 'diverging',
    description: 'Classic red–blue diverging palette with reasonably even steps ' + 'on each side of the midpoint.',
  },
  {
    name: 'purpleorange',
    type: 'diverging',
    description: 'Purple–orange axis with even steps per half and good ' + 'colorblind safety.',
  },
  {
    name: 'brownbluegreen',
    type: 'diverging',
    description: 'Brown ↔ blue-green diverging palette, even per half and ' + 'colorblind-friendly.',
  },
  {
    name: 'purplegreen',
    type: 'diverging',
    description: 'Purple ↔ green diverging palette with even steps per half.',
  },
];

// ─── Recommendation factory ──────────────────────────────────────

/**
 * Turn one candidate into a Recommendation. The `applicableWhen`
 * does:
 *
 *   1. shape match (sequential issue ⇒ sequential candidate),
 *   2. same-scheme exclusion,
 *   3. empirical uniformity check via `findUniformSchemes`, so a
 *      candidate is only ever shown when it genuinely fixes the
 *      issue (never re-triggers the rule).
 */
function buildSchemeSwapRec(candidate: Candidate): Recommendation {
  return {
    id: `uniformity-swap-to-${candidate.name}`,
    label: `Switch to ${candidate.name}`,
    description: candidate.description,
    family: 'replacement',

    applicableWhen(issue) {
      const ev = readUniformityEvidence(issue);
      if (!ev) return false;
      if (ev.scaleType !== candidate.type) return false;
      if (isSameScheme(ev.schemeName, candidate.name)) return false;

      const uniform = findUniformSchemes({
        scaleType: ev.scaleType,
        excludeSchemeName: ev.schemeName,
      });
      return uniform.some((s) => s.name === candidate.name);
    },

    apply(issue, spec) {
      // Pointer addresses scale.scheme or scale.range; its parent is
      // the scale object - same shape as the other scale-swap recs.
      return setScheme(spec, parentPointer(issue.jsonPointer), candidate.name);
    },
  };
}

// ─── Registry ────────────────────────────────────────────────────

export const perceptualUniformityRecommendations: Recommendation[] = [
  ...SEQUENTIAL_CANDIDATES,
  ...DIVERGING_CANDIDATES,
].map(buildSchemeSwapRec);
