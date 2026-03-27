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
  rgb: [number, number, number];
  hsl: [number, number, number];
  families: string[];
};

const COLOR_CHANNELS = ['color', 'fill', 'stroke'] as const;
const KNOWN_COLOR_NAMES: Record<string, string> = {
  red: '#ff0000',
  darkred: '#8b0000',
  crimson: '#dc143c',
  green: '#008000',
  darkgreen: '#006400',
  lime: '#00ff00',
  blue: '#0000ff',
  navy: '#000080',
  purple: '#800080',
  violet: '#ee82ee',
  magenta: '#ff00ff',
  brown: '#a52a2a',
  black: '#000000',
  gray: '#808080',
  grey: '#808080',
  pink: '#ffc0cb',
  turquoise: '#40e0d0',
  cyan: '#00ffff',
  teal: '#008080',
  orange: '#ffa500',
  yellow: '#ffff00',
  white: '#ffffff',
};

const rules = colorRules as ColorRulesKnowledgeBase;

function escapeJsonPointerToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

function normalizeColorLiteral(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const normalized = input.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const value = hex.replace('#', '');
  if (![3, 6].includes(value.length)) return null;

  const expanded =
    value.length === 3
      ? value
          .split('')
          .map((part) => `${part}${part}`)
          .join('')
      : value;

  const parsed = Number.parseInt(expanded, 16);
  if (Number.isNaN(parsed)) return null;

  return [(parsed >> 16) & 255, (parsed >> 8) & 255, parsed & 255];
}

function rgbFunctionToRgb(value: string): [number, number, number] | null {
  const match = value.match(/rgba?\(([^)]+)\)/i);
  if (!match) return null;

  const [r, g, b] = match[1]
    .split(',')
    .slice(0, 3)
    .map((part) => Number.parseFloat(part.trim()));

  if ([r, g, b].some((channel) => Number.isNaN(channel))) return null;

  return [Math.max(0, Math.min(255, r)), Math.max(0, Math.min(255, g)), Math.max(0, Math.min(255, b))];
}

function hslFunctionToRgb(value: string): [number, number, number] | null {
  const match = value.match(/hsla?\(([^)]+)\)/i);
  if (!match) return null;

  const [rawHue, rawSaturation, rawLightness] = match[1]
    .split(',')
    .slice(0, 3)
    .map((part) => part.trim());
  if (!rawHue || !rawSaturation || !rawLightness) return null;

  const hue = Number.parseFloat(rawHue);
  const saturation = Number.parseFloat(rawSaturation.replace('%', '')) / 100;
  const lightness = Number.parseFloat(rawLightness.replace('%', '')) / 100;

  if ([hue, saturation, lightness].some((channel) => Number.isNaN(channel))) return null;

  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hPrime = (((hue % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hPrime % 2) - 1));

  let [r1, g1, b1] = [0, 0, 0];
  if (hPrime < 1) [r1, g1, b1] = [c, x, 0];
  else if (hPrime < 2) [r1, g1, b1] = [x, c, 0];
  else if (hPrime < 3) [r1, g1, b1] = [0, c, x];
  else if (hPrime < 4) [r1, g1, b1] = [0, x, c];
  else if (hPrime < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];

  const m = lightness - c / 2;
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

function parseColorToRgb(normalizedColor: string): [number, number, number] | null {
  if (normalizedColor.startsWith('#')) {
    return hexToRgb(normalizedColor);
  }

  if (normalizedColor.startsWith('rgb')) {
    return rgbFunctionToRgb(normalizedColor);
  }

  if (normalizedColor.startsWith('hsl')) {
    return hslFunctionToRgb(normalizedColor);
  }

  const colorNameHex = KNOWN_COLOR_NAMES[normalizedColor];
  if (colorNameHex) {
    return hexToRgb(colorNameHex);
  }

  return null;
}

function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;

  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  const delta = max - min;

  let hue = 0;
  if (delta !== 0) {
    if (max === rNorm) {
      hue = ((gNorm - bNorm) / delta) % 6;
    } else if (max === gNorm) {
      hue = (bNorm - rNorm) / delta + 2;
    } else {
      hue = (rNorm - gNorm) / delta + 4;
    }
  }

  hue = Math.round((hue * 60 + 360) % 360);
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));

  return [hue, saturation, lightness];
}

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

function evaluateColorCombinationRisk(
  spec: Record<string, any>,
  knowledgeBase: ColorRulesKnowledgeBase,
): AccessibilityIssue[] {
  const extracted = extractExplicitColors(spec);

  const classified: ClassifiedColor[] = extracted
    .map((entry) => {
      const rgb = parseColorToRgb(entry.normalized);
      if (rgb) {
        const hsl = rgbToHsl(rgb);
        const families = classifyColorFamilies(hsl, knowledgeBase.families);
        if (families.length === 0) return null;

        return {
          ...entry,
          rgb,
          hsl,
          families,
        };
      }

      if (entry.source.endsWith('scale.scheme')) {
        const families = inferFamiliesFromSchemeName(entry.normalized, knowledgeBase.families);
        if (families.length === 0) return null;

        return {
          ...entry,
          rgb: [0, 0, 0] as [number, number, number],
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
