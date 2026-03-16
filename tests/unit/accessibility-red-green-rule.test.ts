import {describe, expect, it} from 'vitest';

import {
  evaluateVegaLiteAccessibility,
  redGreenRiskRule,
  redGreenRiskRuleExampleIssue,
} from '../../src/features/accessibility';

describe('redGreenRiskRule', () => {
  it('returns an issue when both red-like and green-like colors are in encoding.color.scale.range', () => {
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
    expect(issues[0].ruleId).toBe(redGreenRiskRule.id);
    expect(issues[0].jsonPointer).toBe('/encoding/color/scale/range');
    expect(issues[0].severity).toBe('warning');
  });

  it('returns no issues when only red-like colors are present', () => {
    const spec = {
      mark: {type: 'bar', color: '#ff0000'},
      config: {
        range: {
          category: ['#b22222', '#ff6347'],
        },
      },
    };

    const issues = evaluateVegaLiteAccessibility(spec);

    expect(issues).toEqual([]);
  });

  it('detects red/green across different inspected locations', () => {
    const spec = {
      mark: {type: 'line', color: 'green'},
      config: {
        range: {
          category: ['#ff0000', '#0000ff'],
        },
      },
    };

    const issues = evaluateVegaLiteAccessibility(spec);

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('red-like and green-like');
    expect(issues[0].evidence).toMatchObject({
      inspectedSources: expect.arrayContaining([
        'encoding.{color|stroke|fill}.scale.range',
        'encoding.{color|stroke|fill}.value',
        'encoding.{color|stroke|fill}.condition.value',
        'mark.{color|stroke|fill}',
        'config.range.category',
        'data.values',
      ]),
    });
  });

  it('detects red/green from inline data when encoding.color.field uses scale: null', () => {
    const spec = {
      data: {
        values: [
          {category: 'A', value: 10, color: 'green'},
          {category: 'B', value: 6, color: 'red'},
        ],
      },
      mark: 'bar',
      encoding: {
        x: {field: 'category', type: 'nominal'},
        y: {field: 'value', type: 'quantitative'},
        color: {field: 'color', type: 'nominal', scale: null},
      },
    };

    const issues = evaluateVegaLiteAccessibility(spec);

    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe(redGreenRiskRule.id);
    expect(issues[0].jsonPointer).toBe('/data/values/0/color');
    expect(issues[0].evidence).toMatchObject({
      redLikeColors: [{value: 'red', source: 'data.values', jsonPointer: '/data/values/1/color'}],
      greenLikeColors: [{value: 'green', source: 'data.values', jsonPointer: '/data/values/0/color'}],
    });
  });

  it('detects conditional red/green encoding values', () => {
    const spec = {
      encoding: {
        color: {
          condition: {
            test: 'datum.value > 0',
            value: 'green',
          },
          value: 'red',
        },
      },
    };

    const issues = evaluateVegaLiteAccessibility(spec);

    expect(issues).toHaveLength(1);
    expect(issues[0].evidence).toMatchObject({
      greenLikeColors: [{value: 'green', source: 'encoding.color.condition.value'}],
      redLikeColors: [{value: 'red', source: 'encoding.color.value'}],
    });
    expect(issues[0].jsonPointer).toBe('/encoding/color/value');
  });

  it('detects layered mark colors', () => {
    const spec = {
      layer: [
        {
          mark: {type: 'bar', color: 'green'},
        },
        {
          mark: {type: 'bar', color: 'red'},
        },
      ],
    };

    const issues = evaluateVegaLiteAccessibility(spec);

    expect(issues).toHaveLength(1);
    expect(issues[0].evidence).toMatchObject({
      greenLikeColors: [{value: 'green', source: 'mark.color', jsonPointer: '/layer/0/mark/color'}],
      redLikeColors: [{value: 'red', source: 'mark.color', jsonPointer: '/layer/1/mark/color'}],
    });
  });

  it('detects red/green when using stroke scale ranges', () => {
    const spec = {
      encoding: {
        stroke: {
          field: 'type',
          scale: {
            range: ['green', 'red'],
          },
        },
      },
    };

    const issues = evaluateVegaLiteAccessibility(spec);

    expect(issues).toHaveLength(1);
    expect(issues[0].evidence).toMatchObject({
      greenLikeColors: [{value: 'green', source: 'encoding.stroke.scale.range'}],
      redLikeColors: [{value: 'red', source: 'encoding.stroke.scale.range'}],
    });
    expect(issues[0].jsonPointer).toBe('/encoding/stroke/scale/range');
  });

  it('provides a stable example issue payload shape', () => {
    expect(redGreenRiskRuleExampleIssue).toMatchObject({
      ruleId: 'vl-a11y-red-green-risk',
      severity: 'warning',
      jsonPointer: '/encoding/color/scale/range',
      evidence: {
        redLikeColors: expect.any(Array),
        greenLikeColors: expect.any(Array),
      },
    });
  });
});
