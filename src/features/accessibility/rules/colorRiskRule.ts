import {parse, converter} from 'culori';

import {AccessibilityIssue, AccessibilityIssueSeverity, AccessibilityRule} from '../types.js';
import colorRules from './colorRules.json';

type ColorFamilyThresholds = {
  saturationMin?: number;
  saturationMax?: number;
  lightnessMin?: number;
  lightnessMax?: number;
  hueRanges?: [number, number][];
};

type ColorFamily = {
  id: string;
  label: string;
  type: 'chromatic' | 'neutral';
  thresholds: ColorFamilyThresholds;
};

type RiskCombination = {
  id: string;
  label: string;
  families: string[];
  severity: AccessibilityIssueSeverity;
  message: string;
  suggestion: string;
  cvdTypes?: string[];
  notes?: string;
  rationale?: string;
};

type ColorRulesKnowledgeBase = {
  schemaVersion: string;
  id: string;
  title: string;
  description: string;
  classificationModel: {
    space: string;
    notes?: string;
  };
  families: ColorFamily[];
  riskyCombinations: RiskCombination[];
};

type ExtractedColor = {
  raw: string;
  normalized: string;
  jsonPointer: string;
  source: string;
};

type ClassifiedColor = ExtractedColor & {
  hsl: [number, number, number];
  families: string[];
};

const COLOR_CHANNELS = ['color', 'fill', 'stroke'] as const;

const rules = colorRules as ColorRulesKnowledgeBase;

// ─── Color parsing (via culori) ──────────────────────────────────

/**
 * Reusable HSL converter — same pattern used in contrastAnalysis.ts
 * and cvdSimulation.ts. Instantiated once and reused.
 */
const toHsl = converter('hsl');

/**
 * Parse any CSS color string to [hue, saturation, lightness].
 *
 *   hue        : degrees in [0, 360]
 *   saturation : fraction in [0, 1]
 *   lightness  : fraction in [0, 1]
 *
 * Same scale colorRules.json already expects — no threshold changes.
 *
 * Culori handles every CSS color form Vega-Lite users might write:
 * hex (#rgb, #rrggbb, #rrggbbaa), rgb()/rgba(), hsl()/hsla(), all
 * 147 named colors, plus lab/lch/oklab/oklch/hwb/color().
 *
 * Achromatic colors (pure grays, black, white) have no defined hue
 * in HSL — culori returns `hue: undefined` for them. We substitute
 * 0, which is safe because our `gray` and `black` family thresholds
 * bound on saturationMax (so hue is irrelevant for those matches).
 */
function parseColorToHsl(input: string): [number, number, number] | null {
  const parsed = parse(input);
  if (!parsed) return null;

  const hsl = toHsl(parsed);
  if (!hsl) return null;

  return [hsl.h ?? 0, hsl.s, hsl.l];
}

// ─── JSON pointer utilities ──────────────────────────────────────

function escapeJsonPointerToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

function normalizeColorLiteral(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const normalized = input.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

// ─── Family classification ───────────────────────────────────────

function isWithinRange(value: number, min?: number, max?: number): boolean {
  if (typeof min === 'number' && value < min) return false;
  if (typeof max === 'number' && value > max) return false;
  return true;
}

function matchesHueRanges(hue: number, ranges?: [number, number][]): boolean {
  if (!ranges || ranges.length === 0) {
    return true;
  }

  return ranges.some(([start, end]) => {
    if (start <= end) {
      return hue >= start && hue <= end;
    }
    return hue >= start || hue <= end;
  });
}

function classifyColorFamilies(hsl: [number, number, number], familyDefinitions: ColorFamily[]): string[] {
  const [hue, saturation, lightness] = hsl;

  return familyDefinitions
    .filter((family) => {
      const thresholds = family.thresholds;
      return (
        isWithinRange(saturation, thresholds.saturationMin, thresholds.saturationMax) &&
        isWithinRange(lightness, thresholds.lightnessMin, thresholds.lightnessMax) &&
        matchesHueRanges(hue, thresholds.hueRanges)
      );
    })
    .map((family) => family.id);
}

// ─── Color extraction from spec ──────────────────────────────────

function pushColor(found: ExtractedColor[], value: unknown, jsonPointer: string, source: string) {
  const normalized = normalizeColorLiteral(value);
  if (!normalized) return;

  found.push({
    raw: value as string,
    normalized,
    jsonPointer,
    source,
  });
}

function pushColorArray(found: ExtractedColor[], value: unknown, jsonPointer: string, source: string) {
  if (!Array.isArray(value)) return;
  value.forEach((entry, index) => pushColor(found, entry, `${jsonPointer}/${index}`, source));
}

function extractColorsFromNode(node: Record<string, any>, pointer: string, found: ExtractedColor[]) {
  const base = pointer || '';

  const mark = node?.mark;
  if (mark && typeof mark === 'object' && !Array.isArray(mark)) {
    for (const channel of COLOR_CHANNELS) {
      pushColor(found, mark[channel], `${base}/mark/${channel}`, `mark.${channel}`);
    }
  }

  for (const channel of COLOR_CHANNELS) {
    const encodingDef = node?.encoding?.[channel];
    if (!encodingDef || typeof encodingDef !== 'object') continue;

    pushColor(found, encodingDef.value, `${base}/encoding/${channel}/value`, `encoding.${channel}.value`);
    pushColorArray(
      found,
      encodingDef?.scale?.range,
      `${base}/encoding/${channel}/scale/range`,
      `encoding.${channel}.scale.range`,
    );
    pushColor(
      found,
      encodingDef?.scale?.scheme,
      `${base}/encoding/${channel}/scale/scheme`,
      `encoding.${channel}.scale.scheme`,
    );
  }

  const configRange = node?.config?.range;
  if (configRange && typeof configRange === 'object' && !Array.isArray(configRange)) {
    for (const [rangeKey, rangeValue] of Object.entries(configRange)) {
      if (Array.isArray(rangeValue)) {
        pushColorArray(found, rangeValue, `${base}/config/range/${escapeJsonPointerToken(rangeKey)}`, 'config.range');
      }
    }
  }
}

function extractExplicitColors(spec: Record<string, any>): ExtractedColor[] {
  const found: ExtractedColor[] = [];

  const walk = (node: unknown, pointer: string) => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${pointer}/${index}`));
      return;
    }

    const objectNode = node as Record<string, any>;
    extractColorsFromNode(objectNode, pointer, found);

    for (const [key, value] of Object.entries(objectNode)) {
      if (value && typeof value === 'object') {
        walk(value, `${pointer}/${escapeJsonPointerToken(key)}`);
      }
    }
  };

  walk(spec, '');
  return found;
}

function inferFamiliesFromSchemeName(schemeName: string, familyDefinitions: ColorFamily[]): string[] {
  const tokens = schemeName.toLowerCase();
  const directFamilyMatches = familyDefinitions
    .map((family) => family.id)
    .filter((familyId) => tokens.includes(familyId));

  if (tokens.includes('rdylgn') || tokens.includes('rdgn')) {
    return Array.from(new Set([...directFamilyMatches, 'red', 'green']));
  }

  return Array.from(new Set(directFamilyMatches));
}

// ─── Main evaluation ─────────────────────────────────────────────

function evaluateColorCombinationRisk(
  spec: Record<string, any>,
  knowledgeBase: ColorRulesKnowledgeBase,
): AccessibilityIssue[] {
  const extracted = extractExplicitColors(spec);

  const classified: ClassifiedColor[] = extracted
    .map((entry) => {
      const hsl = parseColorToHsl(entry.normalized);
      if (hsl) {
        const families = classifyColorFamilies(hsl, knowledgeBase.families);
        if (families.length === 0) return null;

        return {
          ...entry,
          hsl,
          families,
        };
      }

      // Scheme names (e.g. "viridis", "rdylgn") are not parseable as
      // colors — fall back to name-based family inference.
      if (entry.source.endsWith('scale.scheme')) {
        const families = inferFamiliesFromSchemeName(entry.normalized, knowledgeBase.families);
        if (families.length === 0) return null;

        return {
          ...entry,
          hsl: [0, 0, 0] as [number, number, number],
          families,
        };
      }

      return null;
    })
    .filter((entry): entry is ClassifiedColor => entry !== null);

  const familyToColors = new Map<string, ClassifiedColor[]>();
  for (const color of classified) {
    for (const family of color.families) {
      const values = familyToColors.get(family) ?? [];
      values.push(color);
      familyToColors.set(family, values);
    }
  }

  return knowledgeBase.riskyCombinations
    .filter((combination) => combination.families.every((family) => familyToColors.has(family)))
    .map((combination) => {
      const contributing = combination.families.flatMap((family) => familyToColors.get(family) ?? []);
      const representativePointer = contributing[0]?.jsonPointer ?? '';

      return {
        ruleId: `${knowledgeBase.id}:${combination.id}`,
        severity: combination.severity,
        message: combination.message,
        suggestion: combination.suggestion,
        jsonPointer: representativePointer,
        evidence: {
          ruleLabel: combination.label,
          families: combination.families,
          cvdTypes: combination.cvdTypes ?? [],
          rationale: combination.rationale ?? combination.notes ?? null,
          matchedColors: contributing.map((color) => ({
            value: color.normalized,
            source: color.source,
            jsonPointer: color.jsonPointer,
            families: color.families,
            hsl: {
              hue: color.hsl[0],
              saturation: Number(color.hsl[1].toFixed(3)),
              lightness: Number(color.hsl[2].toFixed(3)),
            },
          })),
          familySummary: Object.fromEntries(
            combination.families.map((family) => [
              family,
              (familyToColors.get(family) ?? []).map((color) => ({
                value: color.normalized,
                jsonPointer: color.jsonPointer,
              })),
            ]),
          ),
          extractionSources: [
            'mark.{color|fill|stroke}',
            'encoding.{color|fill|stroke}.value',
            'encoding.{color|fill|stroke}.scale.range[]',
            'encoding.{color|fill|stroke}.scale.scheme',
            'config.range.*[]',
          ],
        },
      } as AccessibilityIssue;
    });
}

// ─── The rule ────────────────────────────────────────────────────

export const colorRiskRule: AccessibilityRule = {
  id: 'vl-a11y-color-risk-engine',
  description:
    'Evaluates color-family combination risks using declarative JSON configuration and HSL-based family matching.',
  evaluate: (spec: Record<string, any>): AccessibilityIssue[] => evaluateColorCombinationRisk(spec, rules),
};

// Backward-compatible alias while transitioning from pair-specific rules.
export const redGreenRiskRule = colorRiskRule;

export const colorRiskRuleExampleIssue: AccessibilityIssue = {
  ruleId: 'vl-a11y-color-risk-rules:red-green',
  severity: 'warning',
  message:
    'The visualization combines red and green families, which can be difficult to distinguish for users with common red-green color vision deficiencies.',
  suggestion: 'Use a colorblind-safe palette (e.g., blue/orange) or add shape, pattern, labels, or direct annotations.',
  jsonPointer: '/encoding/color/scale/range/0',
  evidence: {
    ruleLabel: 'Red/Green pairing',
    families: ['red', 'green'],
    cvdTypes: ['protanopia', 'deuteranopia'],
    matchedColors: [],
  },
};

export const redGreenRiskRuleExampleIssue = colorRiskRuleExampleIssue;