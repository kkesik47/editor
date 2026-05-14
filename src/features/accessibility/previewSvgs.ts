/**
 * previewSvgs.ts
 *
 * Shared SVG preview builders for accessibility issues.
 *
 * Each builder returns a data URI string (e.g. `data:image/svg+xml,...`)
 * suitable for use as the `src` of an `<img>` element, or wrapped in
 * Markdown image syntax for Monaco hover tooltips.
 *
 * An empty string means "no preview is applicable for this issue" —
 * callers should treat empty strings as "skip this preview".
 *
 * Preview types and when they apply:
 *   - CVD simulation:        issues with originalColors + simulatedColors
 *   - Grayscale equivalent:  issues with originalColors + grayscaleColors
 *   - Perceptual uniformity: issues with steps + colorCount
 *   - Contrast on bg:        issues with allColors + allRatios + backgroundColor
 *   - Text sample:           issues with elementType='text' + elementLabel
 */

import type {AccessibilityIssue} from './types.js';

// ─── Shared design tokens ────────────────────────────────────────
//
// Single source of truth for typography, spacing, and palette so
// every preview looks like it belongs to the same family.

/** Font stack matching --base-font-family from app.css. */
const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Type scale (in px). */
const FONT_SIZE_MAIN = 12;   // row labels, section labels
const FONT_SIZE_SMALL = 11;  // captions, ratios, secondary info

/** Spacing unit (in px). All gaps are multiples of this. */
const SPACE = 4;

/** Palette. Keep in sync with --warning-color and the AAA blue in CSS. */
const COLOR_TEXT = '#000000';
const COLOR_BG = '#ffffff';
const COLOR_BORDER = '#cccccc';
const COLOR_FAIL = '#e15759';
const COLOR_PASS = '#59a14f';
const COLOR_AAA = '#1c8ae4';

/** Common <text> style fragments. */
const TEXT_MAIN = `font-family:${FONT_STACK};font-size:${FONT_SIZE_MAIN}px;fill:${COLOR_TEXT};`;
const TEXT_SMALL = `font-family:${FONT_STACK};font-size:${FONT_SIZE_SMALL}px;fill:${COLOR_TEXT};`;

// ─── Helpers ─────────────────────────────────────────────────────

/** Encode an SVG markup string as a data URI suitable for <img src>. */
function svgToDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Format a number for display in previews.
 *
 * Whole numbers render as integers; otherwise one decimal place.
 * Keeps labels visually aligned ("5" vs "5.2", not "5" vs "5.23").
 */
function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1).replace(/\.0$/, '');
}

/**
 * Approximate the rendered width of a text string in px.
 *
 * The multipliers are deliberately generous: real width depends on
 * font family (Segoe UI on Windows is wider than -apple-system on
 * macOS) and which characters appear. Over-estimating is safe — it
 * just leaves a little extra horizontal padding.
 */
function estimateTextWidth(text: string, fontSize: number): number {
  // ~0.62 em is a reasonable upper bound for proportional system fonts.
  return Math.ceil(text.length * fontSize * 0.62);
}

// ─── Shared "Normal vs X" preview builder ────────────────────────

/**
 * Width of the row-label column in the two-row CVD/grayscale preview.
 *
 * Kept fixed (not computed from the longest label) so the colour bars
 * start at the same x across every CVD/grayscale preview in the pane,
 * letting the eye scan a column of previews without horizontal jitter.
 * Sized to fit the longest expected label ("Deuteranopia") at 12 px.
 */
const TWO_ROW_LABEL_W = 90;

/** Max total width for the colour bar / swatch row, to prevent overflow. */
const TWO_ROW_MAX_BAR_W = 280;

/**
 * Build the "Normal vs X" two-row preview used by both the CVD and
 * grayscale previews. Two rows of color swatches (or gradients) with
 * row labels on the left.
 *
 * @param originalColors    - The original CSS colors from the scale.
 * @param transformedColors - The simulated/grayscale CSS colors.
 * @param transformLabel    - Label for the second row (e.g. "Protanopia", "Grayscale").
 * @param isContinuous      - Render a smooth gradient (true) or discrete swatches (false).
 * @returns Data URI string for the rendered SVG.
 */
function buildTwoRowColorPreview(
  originalColors: string[],
  transformedColors: string[],
  transformLabel: string,
  isContinuous: boolean,
): string {
  const barH = 20;
  const rowGap = SPACE + 2;       // 6
  const paddingX = SPACE * 2;     // 8
  const paddingY = SPACE + 2;     // 6

  // For categorical scales: pick a swatch width that keeps the row
  // under TWO_ROW_MAX_BAR_W even with many colours. Minimum width 12
  // (below that swatches stop being readable as distinct cells).
  let barW: number;
  let swatchW = 0;
  const swatchGap = 2;

  if (isContinuous) {
    barW = TWO_ROW_MAX_BAR_W;
  } else {
    const count = Math.max(originalColors.length, 1);
    const ideal = 24;
    const fit = Math.floor((TWO_ROW_MAX_BAR_W + swatchGap) / count) - swatchGap;
    swatchW = Math.max(12, Math.min(ideal, fit));
    barW = count * (swatchW + swatchGap) - swatchGap;
  }

  const svgW = TWO_ROW_LABEL_W + barW + paddingX * 2;
  const svgH = 2 * barH + rowGap + paddingY * 2;
  const normalY = paddingY;
  const simY = paddingY + barH + rowGap;
  const barX = TWO_ROW_LABEL_W + paddingX;

  // Row labels centred vertically against each row.
  const normalLabelY = normalY + barH / 2;
  const simLabelY = simY + barH / 2;

  let defs = '';
  let normalBar = '';
  let simBar = '';

  if (isContinuous) {
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
    const swatchRow = (colors: string[], y: number): string =>
      colors
        .map((color, i) => {
          const x = barX + i * (swatchW + swatchGap);
          return `<rect x="${x}" y="${y}" width="${swatchW}" height="${barH}" fill="${color}" rx="2"/>`;
        })
        .join('');

    normalBar = swatchRow(originalColors, normalY);
    simBar = swatchRow(transformedColors, simY);
  }

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}">`,
    `<rect width="${svgW}" height="${svgH}" fill="${COLOR_BG}" rx="4"/>`,
    defs,
    `<text x="${paddingX}" y="${normalLabelY}" dominant-baseline="middle" style="${TEXT_MAIN}">Normal</text>`,
    normalBar,
    `<text x="${paddingX}" y="${simLabelY}" dominant-baseline="middle" style="${TEXT_MAIN}">${transformLabel}</text>`,
    simBar,
    `</svg>`,
  ].join('');

  return svgToDataUri(svg);
}

// ─── CVD preview ─────────────────────────────────────────────────

/**
 * Build a "Normal vs Simulated CVD" preview.
 *
 * Returns an empty string if the issue has no CVD preview data.
 */
export function buildCvdPreviewDataUri(issue: AccessibilityIssue): string {
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

  return buildTwoRowColorPreview(
    originalColors as string[],
    simulatedColors as string[],
    simLabel,
    isContinuous,
  );
}

// ─── Grayscale preview ──────────────────────────────────────────

/**
 * Build a "Normal vs Grayscale" preview.
 *
 * Returns an empty string if the issue has no grayscale preview data.
 */
export function buildGrayscalePreviewDataUri(issue: AccessibilityIssue): string {
  const {originalColors, grayscaleColors, scaleType} = issue.evidence ?? {};
  if (!Array.isArray(originalColors) || !Array.isArray(grayscaleColors) || originalColors.length === 0) {
    return '';
  }

  const isContinuous = scaleType === 'sequential';

  return buildTwoRowColorPreview(
    originalColors as string[],
    grayscaleColors as string[],
    'Grayscale',
    isContinuous,
  );
}

// ─── Perceptual uniformity preview ──────────────────────────────

/**
 * Build a perceptual-step preview.
 *
 * Layout:
 *   Row 1: full gradient bar of the scale
 *   Row 2: "Biggest color change (33%→40%)"  — swatches + ΔE
 *   Row 3: "Smallest color change (60%→67%)" — swatches + ΔE
 *
 * Position labels use real data values when `domain` is available,
 * otherwise fall back to scale percentages.
 *
 * Returns an empty string if the issue has no step data.
 */
export function buildUniformityPreviewDataUri(issue: AccessibilityIssue): string {
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

  // ── Layout constants ──
  const labelW = 220;
  const paddingX = SPACE * 2;     // 8
  const paddingY = SPACE + 2;     // 6
  const barW = 220;
  const barH = 16;
  const swatchW = 36;
  const swatchH = 22;
  const swatchGap = SPACE + 1;    // 5
  const arrowW = 10;
  const rowGap = SPACE * 2;       // 8
  const barX = labelW + paddingX;

  const gradientY = paddingY;
  const largestY = gradientY + barH + rowGap;
  const smallestY = largestY + swatchH + rowGap;
  const svgW = labelW + barW + paddingX * 2;
  const svgH = smallestY + swatchH + paddingY;

  const gradStops = allColors
    .map((color, i) => {
      const offset = allColors.length === 1 ? 50 : Math.round((i / (allColors.length - 1)) * 100);
      return `<stop offset="${offset}%" stop-color="${color}"/>`;
    })
    .join('');

  const defs = `<defs><linearGradient id="unifGrad">${gradStops}</linearGradient></defs>`;
  const gradientBar = `<rect x="${barX}" y="${gradientY}" width="${barW}" height="${barH}" fill="url(#unifGrad)" rx="2"/>`;

  // "Scale" label centred against the gradient bar
  const scaleLabelY = gradientY + barH / 2;
  const scaleLabel = `<text x="${paddingX}" y="${scaleLabelY}" dominant-baseline="middle" style="${TEXT_MAIN}">Scale</text>`;

  const buildPairRow = (
    label: string,
    colorA: string,
    colorB: string,
    deltaE: number,
    y: number,
  ): string => {
    const swatchAX = barX;
    const arrowX = swatchAX + swatchW + swatchGap;
    const swatchBX = arrowX + arrowW + swatchGap;
    const deltaX = swatchBX + swatchW + SPACE * 2;
    const centerY = y + swatchH / 2;

    const swatchA = `<rect x="${swatchAX}" y="${y}" width="${swatchW}" height="${swatchH}" fill="${colorA}" rx="3" stroke="${COLOR_BORDER}" stroke-width="1"/>`;
    const arrow = `<text x="${arrowX}" y="${centerY}" dominant-baseline="middle" style="${TEXT_MAIN}">→</text>`;
    const swatchB = `<rect x="${swatchBX}" y="${y}" width="${swatchW}" height="${swatchH}" fill="${colorB}" rx="3" stroke="${COLOR_BORDER}" stroke-width="1"/>`;
    const deltaLabel = `<text x="${deltaX}" y="${centerY}" dominant-baseline="middle" style="${TEXT_SMALL}">color difference: ${formatNumber(deltaE)}</text>`;
    const rowLabel = `<text x="${paddingX}" y="${centerY}" dominant-baseline="middle" style="${TEXT_MAIN}">${label}</text>`;

    return [rowLabel, swatchA, arrow, swatchB, deltaLabel].join('');
  };

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}">`,
    `<rect width="${svgW}" height="${svgH}" fill="${COLOR_BG}" rx="4"/>`,
    defs,
    scaleLabel,
    gradientBar,
    buildPairRow(largestLabel, largest.colorA, largest.colorB, largest.deltaE, largestY),
    buildPairRow(smallestLabel, smallest.colorA, smallest.colorB, smallest.deltaE, smallestY),
    `</svg>`,
  ].join('');

  return svgToDataUri(svg);
}

// ─── Contrast (swatch-on-background) preview ────────────────────

/**
 * Build a swatch-on-background preview for contrast issues.
 *
 * Shows each scale color as a swatch on the actual chart background,
 * with failing colors (ratio < threshold) outlined in red and the
 * ratio in red below; passing colors get a green ratio label.
 *
 * Used for both multi-color scale issues and single-color mark issues
 * (which wrap their single color into one-element arrays).
 *
 * Returns an empty string if the issue has no contrast preview data.
 */
export function buildContrastPreviewDataUri(issue: AccessibilityIssue): string {
  const {allColors, allRatios, backgroundColor, threshold} = issue.evidence ?? {};
 
  if (
    !Array.isArray(allColors) ||
    !Array.isArray(allRatios) ||
    allColors.length === 0
  ) {
    return '';
  }
 
  const bg = (backgroundColor as string) ?? COLOR_BG;
  const limit = (threshold as number) ?? 3;
  const colors = allColors as string[];
  const ratios = allRatios as number[];
 
  // ── Layout ──
  const swatchW = 40;
  const swatchH = 35;
  const swatchGap = SPACE + 2;   // 6
  const paddingX = SPACE * 2;    // 8
  const paddingY = SPACE    // 4
  const headerH = FONT_SIZE_MAIN;       // header row height
  const ratioH = FONT_SIZE_SMALL + SPACE;       // ratio row height
  const headerSwatchGap = SPACE*3;                // gap between header and swatches
  const swatchRatioGap = SPACE*1.5;                 // gap between swatches and ratio labels
  const inset = SPACE*2;                          // bg peek-through
 
  const count = colors.length;
  const totalSwatchW = count * (swatchW + swatchGap) - swatchGap;
 
  // Ensure SVG is wide enough for header text.
  const headerText = `Background: ${bg}`;
  const headerNeededW = estimateTextWidth(headerText, FONT_SIZE_MAIN) + paddingX * 2;
 
  const svgW = Math.max(totalSwatchW + paddingX * 2, headerNeededW);
  const svgH = paddingY + headerH + headerSwatchGap + swatchH + swatchRatioGap + ratioH + paddingY;
 
  // ── Header ──
  const headerY = paddingY + headerH / 2;
  const header =
    `<text x="${paddingX}" y="${headerY}" dominant-baseline="middle" style="${TEXT_MAIN}">` +
    `${headerText}</text>`;
 
  // ── Swatches ──
  const swatchY = paddingY + headerH + headerSwatchGap;
  const ratioCenterY = swatchY + swatchH + swatchRatioGap + ratioH / 2;
 
  const swatches = colors
    .map((color, i) => {
      const x = paddingX + i * (swatchW + swatchGap);
      const ratio = ratios[i] ?? 0;
      const fails = ratio < limit;
 
      // Background rect (chart bg shows behind the swatch)
      const bgRect =
        `<rect x="${x}" y="${swatchY}" width="${swatchW}" height="${swatchH}" ` +
        `fill="${bg}" rx="3" stroke="${COLOR_BORDER}" stroke-width="0.5"/>`;
 
      // Color swatch (slightly inset so bg peeks through)
      const swatch =
        `<rect x="${x + inset}" y="${swatchY + inset}" ` +
        `width="${swatchW - inset * 2}" height="${swatchH - inset * 2}" ` +
        `fill="${color}" rx="2"/>`;
 
      // No red border in this variant — the swatch sits fully visible
      // on the background, and the red ratio label below carries the
      // failure signal on its own.
      const border = '';
 
      // Ratio label (red if failing, green if passing)
      const ratioColor = fails ? COLOR_FAIL : COLOR_PASS;
      const ratioLabel =
        `<text x="${x + swatchW / 2}" y="${ratioCenterY}" ` +
        `text-anchor="middle" dominant-baseline="middle" ` +
        `style="font-family:${FONT_STACK};font-size:${FONT_SIZE_SMALL}px;fill:${ratioColor};font-weight:600">` +
        `${formatNumber(ratio)}:1</text>`;
 
      return bgRect + swatch + border + ratioLabel;
    })
    .join('');
 
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}">`,
    `<rect width="${svgW}" height="${svgH}" fill="${COLOR_BG}" rx="4"/>`,
    header,
    swatches,
    `</svg>`,
  ].join('');
 
  return svgToDataUri(svg);
}

// ─── Text-sample preview ────────────────────────────────────────

/**
 * Build a text-sample preview for text contrast issues.
 *
 * Renders the element's own name (e.g. "X-axis labels", "Chart title")
 * in the failing foreground color on the actual background, with a
 * caption underneath that's red for AA fails and blue for AAA
 * suggestions.
 *
 * Returns an empty string if the issue is not a text contrast issue
 * or has no element label.
 */
export function buildTextSamplePreviewDataUri(issue: AccessibilityIssue): string {
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

  const fg = (foregroundColor as string) ?? COLOR_TEXT;
  const bg = (backgroundColor as string) ?? COLOR_BG;
  const ratio = (contrastRatio as number) ?? 0;
  const limit = (threshold as number) ?? 4.5;
  const label = elementLabel as string;
  const isAAA = wcagLevel === 'AAA';

  // ── Layout ──
  const sampleFontSize = 14;
  const sampleVerticalPadding = SPACE * 3;                    // 12
  const sampleH = sampleFontSize + sampleVerticalPadding * 2; // 38
  const paddingX = SPACE * 2;                                 // 8
  const paddingY = SPACE + 2;                                 // 6
  const captionGap = SPACE;                                   // 4
  const captionH = FONT_SIZE_SMALL + SPACE;                   // 15

  // Phrasing differs by WCAG level.
  let captionText: string;
  let captionColor: string;
  if (isAAA) {
    captionText = `${formatNumber(ratio)}:1 — passes AA, falls short of AAA (≥${formatNumber(limit)}:1)`;
    captionColor = COLOR_AAA;
  } else {
    captionText = `${formatNumber(ratio)}:1 — fails AA (needs ≥${formatNumber(limit)}:1)`;
    captionColor = COLOR_FAIL;
  }

  const sampleNeededW = estimateTextWidth(label, sampleFontSize) + SPACE * 8;
  const captionNeededW = estimateTextWidth(captionText, FONT_SIZE_SMALL) + SPACE * 2;

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
    `stroke="${COLOR_BORDER}" stroke-width="1"/>`;

  const sampleTextX = sampleX + sampleW / 2;
  const sampleTextY = sampleY + sampleH / 2;

  const sampleText =
    `<text x="${sampleTextX}" y="${sampleTextY}" ` +
    `text-anchor="middle" dominant-baseline="middle" ` +
    `style="font-family:${FONT_STACK};font-size:${sampleFontSize}px;fill:${fg};">` +
    `${label}</text>`;

  // ── Caption ──
  const captionY = sampleY + sampleH + captionGap + captionH / 2;
  const caption =
    `<text x="${paddingX}" y="${captionY}" dominant-baseline="middle" ` +
    `style="font-family:${FONT_STACK};font-size:${FONT_SIZE_SMALL}px;fill:${captionColor};">` +
    `${captionText}</text>`;

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}">`,
    `<rect width="${svgW}" height="${svgH}" fill="${COLOR_BG}" rx="4"/>`,
    sampleBox,
    sampleText,
    caption,
    `</svg>`,
  ].join('');

  return svgToDataUri(svg);
}

// ─── Convenience: collect all applicable previews for one issue ──

/**
 * Each preview type, paired with a builder. Used by callers that want
 * to render every applicable preview for an issue without knowing
 * which ones apply.
 */
export const PREVIEW_BUILDERS: {
  key: string;
  alt: string;
  build: (issue: AccessibilityIssue) => string;
}[] = [
  {key: 'cvd', alt: 'CVD preview', build: buildCvdPreviewDataUri},
  {key: 'grayscale', alt: 'Grayscale preview', build: buildGrayscalePreviewDataUri},
  {key: 'uniformity', alt: 'Uniformity preview', build: buildUniformityPreviewDataUri},
  {key: 'contrast', alt: 'Contrast preview', build: buildContrastPreviewDataUri},
  {key: 'textSample', alt: 'Text contrast preview', build: buildTextSamplePreviewDataUri},
];