import {AccessibilityIssue, AccessibilityRule} from '../types.js';

type ExtractedColor = {
  color: string;
  jsonPointer: string;
  source: string;
};

const RED_GREEN_RISK_RULE_ID = 'vl-a11y-red-green-risk';

const RED_NAMED_COLORS = new Set([
  'red',
  'darkred',
  'crimson',
  'firebrick',
  'tomato',
  'coral',
  'indianred',
  'salmon',
  'orangered',
]);

const GREEN_NAMED_COLORS = new Set([
  'green',
  'darkgreen',
  'lime',
  'limegreen',
  'seagreen',
  'forestgreen',
  'olivedrab',
  'chartreuse',
]);

const COLOR_CHANNELS = ['color', 'stroke', 'fill'] as const;

function escapeJsonPointerToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1');
}

function normalizeColor(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  return value.length > 0 ? value : null;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const cleaned = hex.replace('#', '').trim();
  if (![3, 6].includes(cleaned.length)) return null;
  const full =
    cleaned.length === 3
      ? cleaned
          .split('')
          .map((c) => c + c)
          .join('')
      : cleaned;
  const int = Number.parseInt(full, 16);
  if (Number.isNaN(int)) return null;
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function rgbStringToRgb(rgbString: string): [number, number, number] | null {
  const match = rgbString.match(/rgba?\(([^)]+)\)/i);
  if (!match) return null;

  const parts = match[1]
    .split(',')
    .slice(0, 3)
    .map((part) => Number.parseFloat(part.trim()));

  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return null;

  return [
    Math.max(0, Math.min(255, parts[0])),
    Math.max(0, Math.min(255, parts[1])),
    Math.max(0, Math.min(255, parts[2])),
  ];
}

function classifyColor(color: string): 'red' | 'green' | null {
  if (RED_NAMED_COLORS.has(color)) return 'red';
  if (GREEN_NAMED_COLORS.has(color)) return 'green';

  let rgb: [number, number, number] | null = null;

  if (color.startsWith('#')) {
    rgb = hexToRgb(color);
  } else if (color.startsWith('rgb')) {
    rgb = rgbStringToRgb(color);
  }

  if (!rgb) return null;

  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);

  // Simple first-pass heuristic: dominant channel determines class.
  if (r === max && r >= g + 20 && r >= b + 20) return 'red';
  if (g === max && g >= r + 20 && g >= b + 20) return 'green';

  return null;
}

function asColorArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeColor).filter((v): v is string => v !== null);
}

function pushIfColor(
  found: ExtractedColor[],
  value: unknown,
  jsonPointer: string,
  source: string,
  isArrayRange: boolean = false,
) {
  if (isArrayRange) {
    for (const color of asColorArray(value)) {
      found.push({color, jsonPointer, source});
    }
    return;
  }

  const normalized = normalizeColor(value);
  if (normalized) {
    found.push({color: normalized, jsonPointer, source});
  }
}

function extractAtNode(node: Record<string, any>, pointer: string, found: ExtractedColor[]) {
  const base = pointer || '';

  for (const channel of COLOR_CHANNELS) {
    const encodingDef = node?.encoding?.[channel];
    if (encodingDef && typeof encodingDef === 'object') {
      pushIfColor(
        found,
        encodingDef?.scale?.range,
        `${base}/encoding/${channel}/scale/range`,
        `encoding.${channel}.scale.range`,
        true,
      );

      pushIfColor(found, encodingDef?.value, `${base}/encoding/${channel}/value`, `encoding.${channel}.value`);

      const conditions = Array.isArray(encodingDef.condition) ? encodingDef.condition : [encodingDef.condition];
      conditions.forEach((cond, idx) => {
        if (!cond || typeof cond !== 'object') return;
        const conditionPointer = Array.isArray(encodingDef.condition)
          ? `${base}/encoding/${channel}/condition/${idx}/value`
          : `${base}/encoding/${channel}/condition/value`;
        pushIfColor(found, cond.value, conditionPointer, `encoding.${channel}.condition.value`);
      });

      const fieldName = encodingDef.field;
      const usesRawValues = encodingDef.scale === null && typeof fieldName === 'string';
      const inlineValues = node?.data?.values;

      if (usesRawValues && Array.isArray(inlineValues)) {
        for (let i = 0; i < inlineValues.length; i++) {
          const row = inlineValues[i];
          if (!row || typeof row !== 'object' || Array.isArray(row)) {
            continue;
          }

          const fieldToken = escapeJsonPointerToken(fieldName);
          pushIfColor(
            found,
            (row as Record<string, unknown>)[fieldName],
            `${base}/data/values/${i}/${fieldToken}`,
            'data.values',
          );
        }
      }
    }
  }

  const mark = node?.mark;
  if (mark && typeof mark === 'object' && !Array.isArray(mark)) {
    for (const channel of COLOR_CHANNELS) {
      pushIfColor(found, mark[channel], `${base}/mark/${channel}`, `mark.${channel}`);
    }
  }

  pushIfColor(found, node?.config?.range?.category, `${base}/config/range/category`, 'config.range.category', true);
}

function extractColors(spec: Record<string, any>): ExtractedColor[] {
  const found: ExtractedColor[] = [];

  const walk = (node: unknown, pointer: string) => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${pointer}/${i}`));
      return;
    }

    const objectNode = node as Record<string, any>;
    extractAtNode(objectNode, pointer, found);

    for (const [key, value] of Object.entries(objectNode)) {
      if (value && typeof value === 'object') {
        walk(value, `${pointer}/${escapeJsonPointerToken(key)}`);
      }
    }
  };

  walk(spec, '');
  return found;
}

function chooseRelevantPointer(colors: ExtractedColor[]): string {
  const priorityPrefixes = ['encoding.', 'data.values', 'mark.', 'config.'];

  for (const prefix of priorityPrefixes) {
    const match = colors.find((c) => c.source.startsWith(prefix));
    if (match) return match.jsonPointer;
  }

  return colors[0]?.jsonPointer ?? '';
}

export const redGreenRiskRule: AccessibilityRule = {
  id: RED_GREEN_RISK_RULE_ID,
  description:
    'Detects explicit red-like and green-like color combinations that may be hard to distinguish for red-green color vision deficiencies.',
  evaluate: (spec: Record<string, any>): AccessibilityIssue[] => {
    const extracted = extractColors(spec);

    const redLike = extracted.filter((c) => classifyColor(c.color) === 'red');
    const greenLike = extracted.filter((c) => classifyColor(c.color) === 'green');

    if (redLike.length === 0 || greenLike.length === 0) {
      return [];
    }

    return [
      {
        ruleId: RED_GREEN_RISK_RULE_ID,
        severity: 'warning',
        message:
          'The chart uses both red-like and green-like colors, which can be difficult to distinguish for users with red-green color vision deficiencies.',
        evidence: {
          redLikeColors: redLike.map((c) => ({value: c.color, source: c.source, jsonPointer: c.jsonPointer})),
          greenLikeColors: greenLike.map((c) => ({value: c.color, source: c.source, jsonPointer: c.jsonPointer})),
          inspectedSources: [
            'encoding.{color|stroke|fill}.scale.range',
            'encoding.{color|stroke|fill}.value',
            'encoding.{color|stroke|fill}.condition.value',
            'mark.{color|stroke|fill}',
            'config.range.category',
            'data.values',
          ],
        },
        jsonPointer: chooseRelevantPointer(
          extracted.filter((c) => {
            const kind = classifyColor(c.color);
            return kind === 'red' || kind === 'green';
          }),
        ),
        suggestion:
          'Consider replacing red/green pairings with a colorblind-safe palette or adding non-color encodings (shape, pattern, labels) to distinguish categories.',
      },
    ];
  },
};

export const redGreenRiskRuleExampleIssue: AccessibilityIssue = {
  ruleId: RED_GREEN_RISK_RULE_ID,
  severity: 'warning',
  message:
    'The chart uses both red-like and green-like colors, which can be difficult to distinguish for users with red-green color vision deficiencies.',
  evidence: {
    redLikeColors: [
      {value: '#d62728', source: 'encoding.color.scale.range', jsonPointer: '/encoding/color/scale/range'},
    ],
    greenLikeColors: [
      {value: '#2ca02c', source: 'encoding.color.scale.range', jsonPointer: '/encoding/color/scale/range'},
    ],
    inspectedSources: [
      'encoding.{color|stroke|fill}.scale.range',
      'encoding.{color|stroke|fill}.value',
      'encoding.{color|stroke|fill}.condition.value',
      'mark.{color|stroke|fill}',
      'config.range.category',
      'data.values',
    ],
  },
  jsonPointer: '/encoding/color/scale/range',
  suggestion:
    'Consider replacing red/green pairings with a colorblind-safe palette or adding non-color encodings (shape, pattern, labels) to distinguish categories.',
};
