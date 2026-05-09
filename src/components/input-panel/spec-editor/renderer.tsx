import stringify from 'json-stringify-pretty-compact';
import Editor from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import * as React from 'react';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useAppContext} from '../../../context/app-context.js';
import './index.css';
import {EDITOR_FOCUS, KEYCODES, Mode, SCHEMA, SIDEPANE} from '../../../constants/index.js';
import {useLocation, useNavigate, useParams} from 'react-router-dom';
import {findNodeAtLocation, parse as parseJSONC, parseTree} from 'jsonc-parser';
import LZString from 'lz-string';
import ResizeObserver from 'rc-resize-observer';
import {debounce} from 'vega';
import parser from 'vega-schema-url-parser';
import type {AccessibilityIssue} from '../../../features/accessibility/types.js';

type MonacoModule = typeof import('monaco-editor');

function jsonPointerToPath(pointer: string): (string | number)[] {
  if (!pointer || pointer === '/') {
    return [];
  }
  return pointer
    .split('/')
    .slice(1)
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'))
    .map((token) => {
      const asNumber = Number(token);
      return Number.isInteger(asNumber) && `${asNumber}` === token ? asNumber : token;
    });
}

// ─── Decoration style helpers ────────────────────────────────────

/**
 * Check whether an issue is a WCAG AAA suggestion (as opposed to
 * a Level A / AA warning). AAA issues get a distinct blue-gray
 * underline to visually separate "must fix" from "nice to have".
 */
function isAAASuggestion(issue: AccessibilityIssue): boolean {
  return issue.evidence?.wcagLevel === 'AAA';
}

// ─── Color preview SVG builders ──────────────────────────────────

/**
 * Shared SVG builder for "Normal vs X" color previews.
 *
 * Both CVD simulation and grayscale previews follow the same layout:
 * two rows of color swatches (or gradients) with labels.
 * This function extracts the common rendering logic.
 *
 * @param originalColors  - The original CSS colors from the scale.
 * @param transformedColors - The simulated/grayscale CSS colors.
 * @param transformLabel  - Label for the second row (e.g. "Protanopia", "Grayscale").
 * @param isContinuous    - Whether to render a smooth gradient or discrete swatches.
 * @returns An encoded SVG data URI string for embedding in Markdown.
 */
function buildColorPreviewSvg(
  originalColors: string[],
  transformedColors: string[],
  transformLabel: string,
  isContinuous: boolean,
): string {
  // Layout constants
  const labelW = 90;
  const barH = 20;
  const rowGap = 6;
  const paddingX = 8;
  const paddingY = 6;
  const barW = isContinuous ? 260 : originalColors.length * 26 - 2;

  const svgW = labelW + barW + paddingX * 2;
  const svgH = 2 * barH + rowGap + paddingY * 2;
  const normalY = paddingY;
  const simY = paddingY + barH + rowGap;
  const textStyle = 'font-family:system-ui,sans-serif;font-size:11px;fill:#333';
  const barX = labelW + paddingX;

  let defs = '';
  let normalBar = '';
  let simBar = '';

  if (isContinuous) {
    // Build gradient stops from the color arrays
    const gradientStops = (colors: string[], id: string): string => {
      const stops = colors
        .map((color, i) => {
          const offset = colors.length === 1 ? 50 : Math.round((i / (colors.length - 1)) * 100);
          return `<stop offset="${offset}%" stop-color="${color}"/>`;
        })
        .join('');
      return `<linearGradient id="${id}">${stops}</linearGradient>`;
    };

    defs = [
      '<defs>',
      gradientStops(originalColors, 'origGrad'),
      gradientStops(transformedColors, 'simGrad'),
      '</defs>',
    ].join('');

    normalBar = `<rect x="${barX}" y="${normalY}" width="${barW}" height="${barH}" fill="url(#origGrad)" rx="2"/>`;
    simBar = `<rect x="${barX}" y="${simY}" width="${barW}" height="${barH}" fill="url(#simGrad)" rx="2"/>`;
  } else {
    // Discrete swatches for categorical scales
    const swatchW = 24;
    const gap = 2;

    const swatchRow = (colors: string[], y: number): string =>
      colors
        .map((color, i) => {
          const x = barX + i * (swatchW + gap);
          return `<rect x="${x}" y="${y}" width="${swatchW}" height="${barH}" fill="${color}" rx="2"/>`;
        })
        .join('');

    normalBar = swatchRow(originalColors, normalY);
    simBar = swatchRow(transformedColors, simY);
  }

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}">`,
    `<rect width="${svgW}" height="${svgH}" fill="#fff" rx="4"/>`,
    defs,
    `<text x="${paddingX}" y="${normalY + 14}" style="${textStyle}">Normal</text>`,
    normalBar,
    `<text x="${paddingX}" y="${simY + 14}" style="${textStyle}">${transformLabel}</text>`,
    simBar,
    `</svg>`,
  ].join('');

  return `![Color preview](data:image/svg+xml,${encodeURIComponent(svg)})`;
}

/**
 * Build an inline SVG showing "Normal" and "Simulated (CVD type)" color previews.
 *
 * Returns an encoded data URI string for embedding in Markdown, or
 * an empty string if the issue has no CVD preview data.
 */
function buildCvdPreviewSvg(issue: AccessibilityIssue): string {
  const {originalColors, simulatedColors, cvdType, scaleType} = issue.evidence ?? {};
  if (!Array.isArray(originalColors) || !Array.isArray(simulatedColors) || originalColors.length === 0) {
    return '';
  }

  const cvdLabels: Record<string, string> = {
    protanopia: 'Protanopia',
    deuteranopia: 'Deuteranopia',
    tritanopia: 'Tritanopia',
  };
  const simLabel = cvdLabels[cvdType as string] ?? 'Simulated';
  const isContinuous = scaleType === 'sequential';

  return buildColorPreviewSvg(originalColors as string[], simulatedColors as string[], simLabel, isContinuous);
}

/**
 * Build an inline SVG showing "Normal" and "Grayscale" color previews.
 *
 * Returns an encoded data URI string for embedding in Markdown, or
 * an empty string if the issue has no grayscale preview data.
 */
function buildGrayscalePreviewSvg(issue: AccessibilityIssue): string {
  const {originalColors, grayscaleColors, scaleType} = issue.evidence ?? {};
  if (!Array.isArray(originalColors) || !Array.isArray(grayscaleColors) || originalColors.length === 0) {
    return '';
  }

  const isContinuous = scaleType === 'sequential';

  return buildColorPreviewSvg(originalColors as string[], grayscaleColors as string[], 'Grayscale', isContinuous);
}

/**
 * Build an inline SVG showing perceptual step unevenness.
 *
 * Layout:
 *   Row 1: full gradient bar of the scale
 *   Row 2: "Most change (33%→40%)"  — swatches + color difference
 *   Row 3: "Least change (60%→67%)" — swatches + color difference
 *
 * The percentages show WHERE in the scale each change occurs,
 * helping users understand which data intervals are affected.
 *
 * Returns an empty string if the issue has no step data.
 */
function buildUniformityPreviewSvg(issue: AccessibilityIssue): string {
  const evidence = issue.evidence ?? {};
  const steps = evidence.steps as
    | {
        deltaE: number;
        colorA: string;
        colorB: string;
        indexA: number;
        indexB: number;
      }[]
    | undefined;
  const colorCount = (evidence.colorCount as number) || 0;
  const domain = evidence.domain as [number, number] | null;
  const fieldName = (evidence.fieldName as string) || null;

  if (!Array.isArray(steps) || steps.length < 2 || colorCount < 2) {
    return '';
  }

  // Find the largest and smallest steps
  let largest = steps[0];
  let smallest = steps[0];
  for (const step of steps) {
    if (step.deltaE > largest.deltaE) largest = step;
    if (step.deltaE < smallest.deltaE) smallest = step;
  }

  // Build position labels — use real data values when domain is
  // available, otherwise fall back to scale percentages.
  const formatPosition = (indexA: number, indexB: number): string => {
    if (domain) {
      const [min, max] = domain;
      const range = max - min;
      const valA = Math.round(min + (indexA / (colorCount - 1)) * range);
      const valB = Math.round(min + (indexB / (colorCount - 1)) * range);
      const label = fieldName ?? 'value';
      return `${label} ${valA}→${valB}`;
    }
    const pctA = Math.round((indexA / (colorCount - 1)) * 100);
    const pctB = Math.round((indexB / (colorCount - 1)) * 100);
    return `${pctA}%→${pctB}%`;
  };

  const largestLabel = `Biggest color change (${formatPosition(largest.indexA, largest.indexB)})`;
  const smallestLabel = `Smallest color change (${formatPosition(smallest.indexA, smallest.indexB)})`;

  // Collect all colors for the gradient (colorA of each step + colorB of last)
  const allColors: string[] = steps.map((s) => s.colorA);
  allColors.push(steps[steps.length - 1].colorB);

  // Layout constants
  const labelW = 220;
  const paddingX = 8;
  const paddingY = 6;
  const barW = 220;
  const barH = 16;
  const swatchW = 36;
  const swatchH = 22;
  const swatchGap = 5;
  const arrowW = 10;
  const rowGap = 8;
  const barX = labelW + paddingX;
  const textStyle = 'font-family:system-ui,sans-serif;font-size:11px;fill:#333';
  const smallTextStyle = 'font-family:system-ui,sans-serif;font-size:10px;fill:#666';

  // Row Y positions
  const gradientY = paddingY;
  const largestY = gradientY + barH + rowGap + 2;
  const smallestY = largestY + swatchH + rowGap;
  const svgW = labelW + barW + paddingX * 2;
  const svgH = smallestY + swatchH + paddingY;

  // Gradient bar (row 1)
  const gradStops = allColors
    .map((color, i) => {
      const offset = allColors.length === 1 ? 50 : Math.round((i / (allColors.length - 1)) * 100);
      return `<stop offset="${offset}%" stop-color="${color}"/>`;
    })
    .join('');

  const defs = `<defs><linearGradient id="unifGrad">${gradStops}</linearGradient></defs>`;
  const gradientBar = `<rect x="${barX}" y="${gradientY}" width="${barW}" height="${barH}" fill="url(#unifGrad)" rx="2"/>`;

  // Helper: build a swatch pair row
  const buildPairRow = (label: string, colorA: string, colorB: string, deltaE: number, y: number): string => {
    const swatchAX = barX;
    const arrowX = swatchAX + swatchW + swatchGap;
    const swatchBX = arrowX + arrowW + swatchGap;
    const deltaX = swatchBX + swatchW + 8;

    const swatchA = `<rect x="${swatchAX}" y="${y}" width="${swatchW}" height="${swatchH}" fill="${colorA}" rx="3" stroke="#ccc" stroke-width="0.5"/>`;
    const arrow = `<text x="${arrowX}" y="${y + 15}" style="${textStyle}">→</text>`;
    const swatchB = `<rect x="${swatchBX}" y="${y}" width="${swatchW}" height="${swatchH}" fill="${colorB}" rx="3" stroke="#ccc" stroke-width="0.5"/>`;
    const deltaLabel = `<text x="${deltaX}" y="${y + 15}" style="${smallTextStyle}">color difference: ${deltaE}</text>`;
    const rowLabel = `<text x="${paddingX}" y="${y + 15}" style="${textStyle}">${label}</text>`;

    return [rowLabel, swatchA, arrow, swatchB, deltaLabel].join('');
  };

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}">`,
    `<rect width="${svgW}" height="${svgH}" fill="#fff" rx="4"/>`,
    defs,
    `<text x="${paddingX}" y="${gradientY + 12}" style="${textStyle}">Scale</text>`,
    gradientBar,
    buildPairRow(largestLabel, largest.colorA, largest.colorB, largest.deltaE, largestY),
    buildPairRow(smallestLabel, smallest.colorA, smallest.colorB, smallest.deltaE, smallestY),
    `</svg>`,
  ].join('');

  return `![Uniformity preview](data:image/svg+xml,${encodeURIComponent(svg)})`;
}

/**
 * Build an inline SVG showing scale colors as swatches on the
 * actual chart background, with failing colors (below threshold)
 * marked with a red border and their contrast ratio in red.
 *
 * Returns an encoded data URI string for embedding in Markdown,
 * or an empty string if the issue has no contrast preview data.
 *
 * Used for both multi-color scale issues and single-color mark
 * issues (which wrap their single color into one-element arrays).
 *
 * Evidence fields used:
 *   - allColors:       string[]   — every color in the scale
 *   - allRatios:       number[]   — contrast ratio per color
 *   - backgroundColor: string     — resolved chart background
 *   - threshold:       number     — the 3:1 threshold
 */
function buildContrastPreviewSvg(issue: AccessibilityIssue): string {
  const {allColors, allRatios, backgroundColor, threshold} = issue.evidence ?? {};

  if (
    !Array.isArray(allColors) ||
    !Array.isArray(allRatios) ||
    allColors.length === 0
  ) {
    return '';
  }

  const bg = (backgroundColor as string) ?? '#ffffff';
  const limit = (threshold as number) ?? 3;
  const colors = allColors as string[];
  const ratios = allRatios as number[];

  // ── Layout ──
  const swatchW = 32;
  const swatchH = 24;
  const gap = 6;
  const paddingX = 8;
  const paddingY = 8;
  const ratioH = 14;  // space for ratio text below swatches
  const headerH = 20; // space for "Background: #xxx" label

  const count = colors.length;
  const totalSwatchW = count * (swatchW + gap) - gap;

  // Ensure the SVG is wide enough for the "Background: #xxx" header
  // text. Without this, single-color and two-color previews end up
  // narrower than the header and clip it (e.g. "Background: #1a4147"
  // gets cropped to "Background: #1a"). Approximate the header width
  // at ~5 px per character for the 11 px system-ui font.
  const headerText = `Background: ${bg}`;
  const headerNeededW = headerText.length * 5 + paddingX * 2 + 4;

  const svgW = Math.max(totalSwatchW + paddingX * 2, headerNeededW);
  const svgH = headerH + swatchH + ratioH + paddingY * 2 + 4;

  const textStyle = 'font-family:system-ui,sans-serif;font-size:10px;';
  const headerStyle = 'font-family:system-ui,sans-serif;font-size:11px;fill:#333;';

  // ── Header ──
  const headerY = paddingY + 11;
  const header =
    `<text x="${paddingX}" y="${headerY}" style="${headerStyle}">` +
    `Background: ${bg}</text>`;

  // ── Swatches ──
  const swatchY = paddingY + headerH + 2;
  const ratioTextY = swatchY + swatchH + 11;
  const inset = 4;

  const swatches = colors
    .map((color, i) => {
      const x = paddingX + i * (swatchW + gap);
      const ratio = ratios[i] ?? 0;
      const fails = ratio < limit;

      // Background rect (the chart bg shows behind the swatch)
      const bgRect =
        `<rect x="${x}" y="${swatchY}" width="${swatchW}" height="${swatchH}" ` +
        `fill="${bg}" rx="3" stroke="#ccc" stroke-width="0.5"/>`;

      // Color swatch (slightly inset so bg peeks through)
      const swatch =
        `<rect x="${x + inset}" y="${swatchY + inset}" ` +
        `width="${swatchW - inset * 2}" height="${swatchH - inset * 2}" ` +
        `fill="${color}" rx="2"/>`;

      // Red border on failing swatches
      const border = fails
        ? `<rect x="${x}" y="${swatchY}" width="${swatchW}" height="${swatchH}" ` +
          `fill="none" stroke="#e15759" stroke-width="2" rx="3"/>`
        : '';

      // Ratio label (red if failing, green if passing)
      const ratioColor = fails ? '#e15759' : '#59a14f';
      const ratioLabel =
        `<text x="${x + swatchW / 2}" y="${ratioTextY}" ` +
        `text-anchor="middle" style="${textStyle}fill:${ratioColor};">` +
        `${ratio}:1</text>`;

      return bgRect + swatch + border + ratioLabel;
    })
    .join('');

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}">`,
    `<rect width="${svgW}" height="${svgH}" fill="#fff" rx="4"/>`,
    header,
    swatches,
    `</svg>`,
  ].join('');

  return `![Contrast preview](data:image/svg+xml,${encodeURIComponent(svg)})`;
}

/**
 * Build an inline SVG previewing a text contrast issue.
 *
 * Renders the element's own name (e.g. "X-axis labels", "Chart title")
 * in the failing foreground color on the actual background — so the
 * user can see the legibility problem the way the chart's reader will.
 *
 * Used for both AA fails (red caption: "fails AA, needs ≥4.5:1") and
 * AAA suggestions (blue caption: "passes AA, falls short of AAA").
 *
 * Returns an empty string if the issue is not a text contrast issue
 * or has no element label.
 *
 * Evidence fields used:
 *   - elementType:     'text'   — gates this preview
 *   - elementLabel:    string   — the human-readable element name
 *   - foregroundColor: string   — resolved text color
 *   - backgroundColor: string   — resolved chart background
 *   - contrastRatio:   number   — measured ratio
 *   - threshold:       number   — 4.5 (AA) or 7 (AAA)
 *   - wcagLevel:       'AA'|'AAA'
 */
function buildTextSamplePreviewSvg(issue: AccessibilityIssue): string {
  const {
    elementType,
    elementLabel,
    foregroundColor,
    backgroundColor,
    contrastRatio,
    threshold,
    wcagLevel,
  } = issue.evidence ?? {};

  if (elementType !== 'text' || typeof elementLabel !== 'string') {
    return '';
  }

  const fg = (foregroundColor as string) ?? '#000000';
  const bg = (backgroundColor as string) ?? '#ffffff';
  const ratio = (contrastRatio as number) ?? 0;
  const limit = (threshold as number) ?? 4.5;
  const label = elementLabel as string;
  const isAAA = wcagLevel === 'AAA';

  // ── Layout ──
  const sampleFontSize = 14;
  const sampleH = 38;
  const paddingX = 8;
  const paddingY = 6;
  const captionGap = 4;
  const captionH = 14;

  // Phrasing differs by WCAG level:
  //   AA  → ratio is below 4.5, so this is a real fail (red)
  //   AAA → ratio passes AA but is below 7, suggestion only (blue)
  let captionText: string;
  let captionColor: string;
  if (isAAA) {
    captionText = `${ratio}:1 — passes AA, falls short of AAA (≥${limit}:1)`;
    captionColor = '#1c8ae4';
  } else {
    captionText = `${ratio}:1 — fails AA (needs ≥${limit}:1)`;
    captionColor = '#e15759';
  }

  // Approximate text widths at the system-ui font:
  //   sample text at 14 px ≈ 8 px per character
  //   caption  text at 11 px ≈ 6.5 px per character
  // Width must accommodate both, with comfortable padding inside the
  // sample box around the rendered label.
  const sampleNeededW = label.length * 8 + 32;
  const captionNeededW = captionText.length * 6.5 + 4;

  const innerW = Math.max(sampleNeededW, captionNeededW, 200);
  const svgW = innerW + paddingX * 2;
  const svgH = paddingY + sampleH + captionGap + captionH + paddingY;

  // ── Sample box ──
  const sampleX = paddingX;
  const sampleY = paddingY;
  const sampleW = innerW;

  const sampleBox =
    `<rect x="${sampleX}" y="${sampleY}" width="${sampleW}" ` +
    `height="${sampleH}" fill="${bg}" rx="3" ` +
    `stroke="#ccc" stroke-width="0.5"/>`;

  // Vertically center the text inside the sample box.
  const sampleTextX = sampleX + sampleW / 2;
  const sampleTextY = sampleY + sampleH / 2 + sampleFontSize / 2 - 1;

  const sampleText =
    `<text x="${sampleTextX}" y="${sampleTextY}" ` +
    `text-anchor="middle" ` +
    `style="font-family:system-ui,sans-serif;` +
    `font-size:${sampleFontSize}px;fill:${fg};">` +
    `${label}</text>`;

  // ── Caption ──
  const captionY = sampleY + sampleH + captionGap + 11;
  const caption =
    `<text x="${paddingX}" y="${captionY}" ` +
    `style="font-family:system-ui,sans-serif;` +
    `font-size:11px;fill:${captionColor};">` +
    `${captionText}</text>`;

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}">`,
    `<rect width="${svgW}" height="${svgH}" fill="#fff" rx="4"/>`,
    sampleBox,
    sampleText,
    caption,
    `</svg>`,
  ].join('');

  return `![Text contrast preview](data:image/svg+xml,${encodeURIComponent(svg)})`;
}

// ─── Issue → decoration / marker conversion ─────────────────────

/**
 * Convert accessibility issues into Monaco editor decorations.
 *
 * Creates wavy underline decorations with hover tooltips for each
 * issue. The jsonPointer on the issue determines which JSON node
 * gets underlined:
 *   - Inline values (e.g. "labelFontSize": 9) → underlines just the value
 *   - Config values → underlines the config property value
 *   - Default values → underlines the specific channel (e.g. /encoding/x)
 *
 * AAA-level issues (suggestions) get a distinct blue-gray underline
 * to visually separate them from mandatory A/AA warnings (yellow).
 */
function toIssueDecorations(
  issues: AccessibilityIssue[],
  editor: Monaco.editor.IStandaloneCodeEditor | null,
): Monaco.editor.IModelDeltaDecoration[] {
  const model = editor?.getModel();
  if (!model) {
    return [];
  }

  const tree = parseTree(model.getValue());
  if (!tree) {
    return [];
  }

  const decorations: Monaco.editor.IModelDeltaDecoration[] = [];
  for (const issue of issues) {
    if (issue.jsonPointer == null) {
      continue;
    }

    const path = jsonPointerToPath(issue.jsonPointer);
    const node = findNodeAtLocation(tree, path);
    if (!node) {
      continue;
    }

    const start = model.getPositionAt(node.offset);
    const end = model.getPositionAt(node.offset + node.length);

    // Build the hover content — add color preview when available
    const cvdPreview = buildCvdPreviewSvg(issue);
    const grayscalePreview = buildGrayscalePreviewSvg(issue);
    const uniformityPreview = buildUniformityPreviewSvg(issue);
    const contrastPreview = buildContrastPreviewSvg(issue);
    const textSamplePreview = buildTextSamplePreviewSvg(issue);

    // AAA issues are framed as suggestions, not problems
    const isAAA = isAAASuggestion(issue);
    const header = isAAA ? `**Accessibility suggestion** (WCAG AAA)` : `**Accessibility** (${issue.severity})`;

    const hoverParts = [header, '', issue.message, '', `Suggestion: ${issue.suggestion}`];
    if (cvdPreview) {
      hoverParts.push('', cvdPreview);
    }
    if (grayscalePreview) {
      hoverParts.push('', grayscalePreview);
    }
    if (uniformityPreview) {
      hoverParts.push('', uniformityPreview);
    }
    if (contrastPreview) {
      hoverParts.push('', contrastPreview);
    }
    if (textSamplePreview) {
      hoverParts.push('', textSamplePreview);
    }

    // Pick decoration class based on WCAG level
    const inlineClass = isAAA ? 'a11ySuggestionInlineDecoration' : 'a11yInlineDecoration';
    const rangeClass = isAAA ? 'a11ySuggestionRangeDecoration' : 'a11yRangeDecoration';

    decorations.push({
      range: {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      },
      options: {
        className: rangeClass,
        inlineClassName: inlineClass,
        stickiness: 1,
        hoverMessage: {
          value: hoverParts.join('\n'),
          supportHtml: true,
          isTrusted: true,
        },
      },
    });
  }

  return decorations;
}

/**
 * Convert accessibility issues into Monaco marker data for the
 * problems panel.
 *
 * Markers use zero-width ranges (startColumn === endColumn) placed
 * at line start so they feed the problems panel without generating
 * a hover tooltip that would overlap with the decoration hover.
 */
function toIssueMarkers(
  issues: AccessibilityIssue[],
  editor: Monaco.editor.IStandaloneCodeEditor | null,
  monaco: MonacoModule | null,
): Monaco.editor.IMarkerData[] {
  const model = editor?.getModel();
  if (!model || !monaco) {
    return [];
  }

  const tree = parseTree(model.getValue());
  if (!tree) {
    return [];
  }

  // Map issue severity to Monaco marker severity
  const severityMap: Record<string, Monaco.MarkerSeverity> = {
    error: monaco.MarkerSeverity.Error,
    warning: monaco.MarkerSeverity.Warning,
    info: monaco.MarkerSeverity.Info,
  };

  const markers: Monaco.editor.IMarkerData[] = [];
  for (const issue of issues) {
    if (issue.jsonPointer == null) {
      continue;
    }

    const path = jsonPointerToPath(issue.jsonPointer);
    const node = findNodeAtLocation(tree, path);
    if (!node) {
      continue;
    }

    const start = model.getPositionAt(node.offset);
    const markerSeverity = severityMap[issue.severity] ?? monaco.MarkerSeverity.Warning;

    markers.push({
      startLineNumber: start.lineNumber,
      // Place zero-width marker at column 1 (line start / whitespace)
      // so it feeds the problems panel but never triggers a hover
      // tooltip that would overlap with our decoration hover.
      startColumn: 1,
      endLineNumber: start.lineNumber,
      endColumn: 1,
      severity: markerSeverity,
      source: issue.ruleId,
      message: `${issue.message}\nSuggestion: ${issue.suggestion}`,
    });
  }
  return markers;
}

// ─── Editor component ────────────────────────────────────────────

const EditorWithNavigation: React.FC<{
  clearConfig: () => void;
  extractConfigSpec: () => void;
  logError: (error: Error) => void;
  mergeConfigSpec: () => void;
  parseSpec: (force: boolean) => void;
  setConfig: (config: string) => void;
  setDecorations: (decorations: any[]) => void;
  setEditorFocus: (focus: any) => void;
  setEditorReference: (reference: any) => void;
  updateEditorString: (editorString: string) => void;
  updateVegaLiteSpec: (spec: string, config?: string) => void;
  updateVegaSpec: (spec: string, config?: string) => void;
}> = (props) => {
  const {state} = useAppContext();
  const {mode, editorString, decorations, manualParse, parse, sidePaneItem, configEditorString, accessibilityIssues} =
    state;

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<MonacoModule | null>(null);
  const [currentDecorationIds, setCurrentDecorationIds] = useState<string[]>([]);

  const navigate = useNavigate();
  const location = useLocation();
  const {compressed} = useParams<{compressed?: string}>();

  const updateSpec = useCallback(
    (spec: string, config: string = undefined) => {
      let parsedMode = mode;
      try {
        const schema = parseJSONC(spec).$schema;
        if (schema) {
          const parsedSchema = parser(schema);
          if (parsedSchema.library === 'vega-lite') {
            parsedMode = Mode.VegaLite;
          } else if (parsedSchema.library === 'vega') {
            parsedMode = Mode.Vega;
          }
        }
      } catch (e) {
        // spec is not a valid JSON
      }

      if (parsedMode === Mode.Vega) {
        props.updateVegaSpec(spec, config);
      } else {
        props.updateVegaLiteSpec(spec, config);
      }
    },
    [mode, props.updateVegaSpec, props.updateVegaLiteSpec],
  );

  const debouncedUpdateSpec = useCallback(debounce(1200, updateSpec), [updateSpec]);

  useEffect(() => {
    if (compressed) {
      let spec: string = LZString.decompressFromEncodedURIComponent(compressed);
      if (spec) {
        try {
          const newlines = (spec.match(/\n/g) || '').length + 1;
          if (newlines <= 1) {
            spec = stringify(parseJSONC(spec));
          }
          if (spec !== editorString) {
            updateSpec(spec);
          }
        } catch (e) {
          props.logError(e as Error);
        }
      } else {
        props.logError(new Error(`Failed to decompress URL. Expected a specification, but received ${spec}`));
      }
    }
  }, [compressed, editorString, props.logError, updateSpec]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (manualParse) {
        if ((e.keyCode === KEYCODES.B || e.keyCode === KEYCODES.S) && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          props.parseSpec(true);
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [manualParse, props.parseSpec]);

  useEffect(() => {
    if (editorRef.current && parse) {
      editorRef.current.focus();
      editorRef.current.layout();
      updateSpec(editorString, configEditorString);
      props.parseSpec(false);
    }
  }, [parse, editorString, configEditorString, updateSpec, props]);

  useEffect(() => {
    if (sidePaneItem === SIDEPANE.Editor && editorRef.current) {
      editorRef.current.focus();
      editorRef.current.layout();
    }
  }, [sidePaneItem]);

  const handleEditorDidMount = useCallback(
    (editor: Monaco.editor.IStandaloneCodeEditor, monaco: MonacoModule) => {
      editorRef.current = editor;
      monacoRef.current = monaco;
      props.setEditorReference(editor);

      const addVegaSchemaURL = () => {
        try {
          let spec = parseJSONC(editor.getValue());
          if (spec.$schema === undefined) {
            spec = {
              $schema: SCHEMA[Mode.Vega],
              ...spec,
            };
            if (confirm('Adding schema URL will format the specification too.')) {
              props.updateVegaSpec(stringify(spec));
            }
          }
        } catch (e) {
          props.logError(e as Error);
        }
      };

      const addVegaLiteSchemaURL = () => {
        try {
          let spec = parseJSONC(editor.getValue());
          if (spec.$schema === undefined) {
            spec = {
              $schema: SCHEMA[Mode.VegaLite],
              ...spec,
            };
            if (confirm('Adding schema URL will format the specification too.')) {
              props.updateVegaLiteSpec(stringify(spec));
            }
          }
        } catch (e) {
          props.logError(e as Error);
        }
      };

      const handleMergeConfig = () => {
        if (confirm('The spec will be formatted on merge.')) {
          if (location.pathname !== '/edited') {
            navigate('/edited');
          }
          props.mergeConfigSpec();
        }
      };

      const handleExtractConfig = () => {
        if (confirm('The spec and config will be formatted.')) {
          props.extractConfigSpec();
        }
      };

      editor.onDidFocusEditorText(() => {
        props.setEditorFocus(EDITOR_FOCUS.SpecEditor);
        props.setEditorReference(editor);
      });

      editor.addAction({
        contextMenuGroupId: 'vega',
        contextMenuOrder: 0,
        id: 'ADD_VEGA_SCHEMA',
        label: 'Add Vega schema URL',
        run: addVegaSchemaURL,
      });

      editor.addAction({
        contextMenuGroupId: 'vega',
        contextMenuOrder: 1,
        id: 'ADD_VEGA_LITE_SCHEMA',
        label: 'Add Vega-Lite schema URL',
        run: addVegaLiteSchemaURL,
      });

      editor.addAction({
        contextMenuGroupId: 'vega',
        contextMenuOrder: 2,
        id: 'CLEAR_EDITOR',
        label: 'Clear Spec',
        run: () => {
          if (mode === Mode.Vega) {
            navigate('/custom/vega');
          } else {
            navigate('/custom/vega-lite');
          }
        },
      });

      editor.addAction({
        contextMenuGroupId: 'vega',
        contextMenuOrder: 3,
        id: 'MERGE_CONFIG',
        label: 'Merge Config Into Spec',
        run: handleMergeConfig,
      });

      editor.addAction({
        contextMenuGroupId: 'vega',
        contextMenuOrder: 4,
        id: 'EXTRACT_CONFIG',
        label: 'Extract Config From Spec',
        run: handleExtractConfig,
      });
    },
    [props, manualParse, debouncedUpdateSpec, location.pathname, navigate, mode],
  );

  const handleEditorChange = useCallback(
    (value: string) => {
      if (manualParse) {
        props.updateEditorString(value);
      } else {
        debouncedUpdateSpec(value);
      }
      if (location.pathname.indexOf('/edited') === -1) {
        navigate('/edited');
      }
    },
    [manualParse, props.updateEditorString, debouncedUpdateSpec, location.pathname, navigate],
  );

  const mergedDecorations = useMemo(() => {
    const issueDecorations = toIssueDecorations(accessibilityIssues || [], editorRef.current);
    return [...(Array.isArray(decorations) ? decorations : []), ...issueDecorations];
  }, [accessibilityIssues, decorations, editorString]);

  useEffect(() => {
    if (editorRef.current) {
      const newDecorationIds = editorRef.current.deltaDecorations(currentDecorationIds, mergedDecorations);
      setCurrentDecorationIds(newDecorationIds);
    }
  }, [mergedDecorations]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model || !monacoRef.current) {
      return;
    }

    const markers = toIssueMarkers(accessibilityIssues || [], editorRef.current, monacoRef.current);
    monacoRef.current.editor.setModelMarkers(model, 'vega-editor-a11y', markers);
  }, [accessibilityIssues, editorString]);

  return (
    <ResizeObserver
      onResize={({width, height}) => {
        editorRef.current?.layout({width, height});
      }}
    >
      <div style={{width: '100%', height: '100%', display: 'flex', flexDirection: 'column'}}>
        <div style={{flexGrow: 1, position: 'relative'}}>
          <Editor
            height="100%"
            language="json"
            value={editorString}
            onMount={handleEditorDidMount}
            onChange={handleEditorChange}
            options={{
              cursorBlinking: 'smooth',
              folding: true,
              lineNumbersMinChars: 4,
              minimap: {enabled: false},
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              quickSuggestions: true,
              stickyScroll: {
                enabled: false,
              },
            }}
          />
        </div>
      </div>
    </ResizeObserver>
  );
};

export default EditorWithNavigation;