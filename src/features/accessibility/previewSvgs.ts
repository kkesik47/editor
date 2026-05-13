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

// ─── Helpers ─────────────────────────────────────────────────────

/** Encode an SVG markup string as a data URI suitable for <img src>. */
function svgToDataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// ─── Shared "Normal vs X" preview builder ────────────────────────

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
  const textStyle = 'font-family:system-ui,sans-serif;font-size:11px;fill:#000000';
  const barX = labelW + paddingX;

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
  const textStyle = 'font-family:-apple-system,system-ui,sans-serif;font-size:12px;fill:#000000;';
  const smallTextStyle = 'font-family:-apple-system,system-ui,sans-serif;font-size:11px;fill:#000000;';

  const gradientY = paddingY;
  const largestY = gradientY + barH + rowGap + 2;
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
  const ratioH = 14;
  const headerH = 20;

  const count = colors.length;
  const totalSwatchW = count * (swatchW + gap) - gap;

  // Ensure the SVG is wide enough for the "Background: #xxx" header.
  // Approximate ~5 px per character for the 11 px system-ui font.
  const headerText = `Background: ${bg}`;
  const headerNeededW = headerText.length * 5 + paddingX * 2 + 4;

  const svgW = Math.max(totalSwatchW + paddingX * 2, headerNeededW);
  const svgH = headerH + swatchH + ratioH + paddingY * 2 + 4;

  const textStyle = 'font-family:-apple-system,system-ui,sans-serif;font-size:10px;';
  const headerStyle = 'font-family:-apple-system,system-ui,sans-serif;font-size:11px;fill:#000000;';

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

      // Background rect (chart bg shows behind the swatch)
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