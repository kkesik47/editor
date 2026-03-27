import {describe, expect, it} from 'vitest';

import {
  evaluateVegaLiteAccessibility,
  colorRiskRule,
  colorRiskRuleExampleIssue,
} from '../../src/features/accessibility';

describe('colorRiskRule (generic data-driven evaluator)', () => {
  it('detects red/green risk from explicit scale range values', () => {
    const spec = {
      encoding: {
        color: {
          scale: {
            range: ['#d62728', '#2ca02c', '#1f77b4'],
          },
        },
      },
    };

    const issues = evaluateVegaLiteAccessibility(spec);

    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe('vl-a11y-color-risk-rules:red-green');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].jsonPointer).toBe('/encoding/color/scale/range/0');
  });

  it('detects configured non-red-green combinations from the same evaluator', () => {
    const spec = {
      mark: {
        type: 'point',
        color: 'purple',
      },
      encoding: {
        fill: {
          value: 'blue',
        },
      },
    };

    const issues = evaluateVegaLiteAccessibility(spec);

    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe('vl-a11y-color-risk-rules:purple-blue');
    expect(issues[0].severity).toBe('info');
    expect(issues[0].evidence).toMatchObject({
      families: ['purple', 'blue'],
    });
  });

  it('uses structured evidence with family mapping and extraction sources', () => {
    const spec = {
      encoding: {
        stroke: {
          scale: {
            range: ['green', 'red'],
          },
        },
      },
    };

    const issues = evaluateVegaLiteAccessibility(spec);

    expect(issues).toHaveLength(1);
    expect(issues[0].evidence).toMatchObject({
      ruleLabel: 'Red/Green pairing',
      families: ['red', 'green'],
      extractionSources: expect.arrayContaining([
        'mark.{color|fill|stroke}',
        'encoding.{color|fill|stroke}.value',
        'encoding.{color|fill|stroke}.scale.range[]',
        'config.range.*[]',
      ]),
    });
  });

  it('returns no issues when no configured risky combination is present', () => {
    const spec = {
      mark: {type: 'bar', color: '#0000ff'},
      encoding: {
        fill: {value: '#00ffff'},
      },
    };

    const issues = evaluateVegaLiteAccessibility(spec);

    expect(issues).toEqual([]);
  });

  it('keeps default accessibility rules wired to the generic color risk rule', () => {
    expect(colorRiskRule.id).toBe('vl-a11y-color-risk-engine');
    expect(colorRiskRuleExampleIssue).toMatchObject({
      ruleId: 'vl-a11y-color-risk-rules:red-green',
      severity: 'warning',
      evidence: {
        ruleLabel: 'Red/Green pairing',
        families: ['red', 'green'],
      },
    });
  });
});
