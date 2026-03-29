/**
 * Tests for the colorblind safety rule.
 *
 * Run with: npx vitest --project unit tests/unit/colorblindSafetyRule.test.ts
 */
import {describe, it, expect} from 'vitest';
import {colorblindSafetyRule} from '../../src/features/accessibility/rules/colorblindSafetyRule';

describe('colorblindSafetyRule', () => {
  // ─── Safe scales should produce no issues ───────────────────

  it('passes a viridis sequential scheme (known CVD-safe)', () => {
    const spec = {
      encoding: {
        color: {
          field: 'value',
          type: 'quantitative',
          scale: {scheme: 'viridis'},
        },
      },
    };
    const issues = colorblindSafetyRule.evaluate(spec);
    expect(issues).toHaveLength(0);
  });

  it('passes a cividis sequential scheme (designed for CVD)', () => {
    const spec = {
      encoding: {
        color: {
          field: 'value',
          type: 'quantitative',
          scale: {scheme: 'cividis'},
        },
      },
    };
    const issues = colorblindSafetyRule.evaluate(spec);
    expect(issues).toHaveLength(0);
  });

  it('passes plasma (known CVD-safe)', () => {
    const spec = {
      encoding: {
        color: {
          field: 'value',
          type: 'quantitative',
          scale: {scheme: 'plasma'},
        },
      },
    };
    const issues = colorblindSafetyRule.evaluate(spec);
    expect(issues).toHaveLength(0);
  });

  it('passes inferno (known CVD-safe)', () => {
    const spec = {
      encoding: {
        color: {
          field: 'value',
          type: 'quantitative',
          scale: {scheme: 'inferno'},
        },
      },
    };
    const issues = colorblindSafetyRule.evaluate(spec);
    expect(issues).toHaveLength(0);
  });

  it('passes magma (known CVD-safe)', () => {
    const spec = {
      encoding: {
        color: {
          field: 'value',
          type: 'quantitative',
          scale: {scheme: 'magma'},
        },
      },
    };
    const issues = colorblindSafetyRule.evaluate(spec);
    expect(issues).toHaveLength(0);
  });

  it('passes an empty spec with no encoding', () => {
    const issues = colorblindSafetyRule.evaluate({});
    expect(issues).toHaveLength(0);
  });

  it('passes a spec with encoding but no explicit scale', () => {
    const spec = {
      encoding: {
        color: {field: 'category', type: 'nominal'},
      },
    };
    const issues = colorblindSafetyRule.evaluate(spec);
    expect(issues).toHaveLength(0);
  });

  // ─── Problematic scales should produce issues ───────────────

  it('flags a red-green categorical range', () => {
    const spec = {
      encoding: {
        color: {
          field: 'category',
          type: 'nominal',
          scale: {range: ['#d62728', '#2ca02c']},
        },
      },
    };
    const issues = colorblindSafetyRule.evaluate(spec);
    expect(issues.length).toBeGreaterThan(0);

    // Should flag at least protanopia or deuteranopia
    const cvdTypes = issues.map((issue) => issue.evidence.cvdType);
    const hasRedGreenDeficiency =
      cvdTypes.includes('protanopia') || cvdTypes.includes('deuteranopia');
    expect(hasRedGreenDeficiency).toBe(true);
  });

  it('flags a rainbow scheme (fold-over under CVD)', () => {
    const spec = {
      encoding: {
        color: {
          field: 'value',
          type: 'quantitative',
          scale: {scheme: 'rainbow'},
        },
      },
    };
    const issues = colorblindSafetyRule.evaluate(spec);
    expect(issues.length).toBeGreaterThan(0);

    // Rainbow should fail under protanopia or deuteranopia because
    // the green zone and the red zone fold onto the same simulated color
    const cvdTypes = issues.map((issue) => issue.evidence.cvdType);
    const hasRedGreenDeficiency =
      cvdTypes.includes('protanopia') || cvdTypes.includes('deuteranopia');
    expect(hasRedGreenDeficiency).toBe(true);
  });

  // ─── Scheme object syntax ───────────────────────────────────

  it('handles scheme as object with name, count, and extent', () => {
    const spec = {
      encoding: {
        color: {
          field: 'value',
          type: 'quantitative',
          scale: {
            scheme: {name: 'viridis', count: 7, extent: [0.1, 0.9]},
          },
        },
      },
    };
    const issues = colorblindSafetyRule.evaluate(spec);
    // Viridis should still be safe even with count/extent
    expect(issues).toHaveLength(0);
  });

  // ─── Multiple channels ─────────────────────────────────────

  it('checks fill and stroke channels too', () => {
    const spec = {
      encoding: {
        fill: {
          field: 'category',
          type: 'nominal',
          scale: {range: ['red', 'green', 'blue']},
        },
      },
    };
    const issues = colorblindSafetyRule.evaluate(spec);
    // red + green in the same categorical palette should flag
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].evidence.channel).toBe('fill');
  });

  // ─── Nested / layered specs ─────────────────────────────────

  it('finds scales inside layers', () => {
    const spec = {
      layer: [
        {
          encoding: {
            color: {
              field: 'x',
              type: 'nominal',
              scale: {range: ['#d62728', '#2ca02c']},
            },
          },
        },
      ],
    };
    const issues = colorblindSafetyRule.evaluate(spec);
    expect(issues.length).toBeGreaterThan(0);
  });

  // ─── Issue structure ────────────────────────────────────────

  it('produces well-formed AccessibilityIssue objects', () => {
    const spec = {
      encoding: {
        color: {
          field: 'category',
          type: 'nominal',
          scale: {range: ['#d62728', '#2ca02c']},
        },
      },
    };
    const issues = colorblindSafetyRule.evaluate(spec);
    expect(issues.length).toBeGreaterThan(0);

    const issue = issues[0];
    expect(issue.ruleId).toMatch(/^vl-a11y-colorblind-safety:/);
    expect(issue.severity).toBe('warning');
    expect(issue.message).toBeTruthy();
    expect(issue.suggestion).toBeTruthy();
    expect(issue.jsonPointer).toBe('/encoding/color/scale/range');
    expect(issue.evidence).toBeDefined();
    expect(issue.evidence.cvdType).toBeTruthy();
    expect(issue.evidence.minDeltaE).toBeTypeOf('number');
    expect(issue.evidence.problematicPairs).toBeInstanceOf(Array);
  });

  // ─── Stride pairs catch fold-over ───────────────────────────

  it('rainbow stride pairs include non-adjacent indices', () => {
    const spec = {
      encoding: {
        color: {
          field: 'value',
          type: 'quantitative',
          scale: {scheme: 'rainbow'},
        },
      },
    };
    const issues = colorblindSafetyRule.evaluate(spec);
    expect(issues.length).toBeGreaterThan(0);

    // At least one problematic pair should be a stride pair (indexB - indexA > 1)
    const allPairs = issues.flatMap(
      (issue) => issue.evidence.problematicPairs as any[],
    );
    const hasStridePair = allPairs.some(
      (pair) => pair.indexB - pair.indexA > 1,
    );
    expect(hasStridePair).toBe(true);
  });
});