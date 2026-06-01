/**
 * references.ts
 *
 * Central registry of scientific papers, standards, and authoritative
 * sources that ground each accessibility rule in published research.
 *
 * Each reference is a typed object with:
 *   - shortCitation : APA in-text form ("Brettel et al., 1997") with
 *                     NO outer parentheses, so multiple shortCitations
 *                     can be joined with "; " inside a single bracket:
 *                     "(Brettel et al., 1997; Sharma et al., 2005)"
 *   - fullCitation  : full APA-style citation for the references panel
 *   - url           : DOI URL when available, otherwise the canonical source URL
 *   - type          : 'paper' | 'standard' | 'book' | 'web' — used for filtering and rendering
 *
 * Usage in a rule:
 *
 *     import {BRETTEL_1997, BIRCH_2012} from '../references.js';
 *
 *     export const colorblindSafetyRule: AccessibilityRule = {
 *       id: 'vl-a11y-colorblind-safety',
 *       description: '...',
 *       references: [BRETTEL_1997, BIRCH_2012],
 *       evaluate(spec) { ... },
 *     };
 *
 * The thesis bibliography is managed independently in Zotero. The same
 * papers appear in both, but there is no mechanical key-matching — this
 * file is the source of truth for code-side citations, the .bib is the
 * source of truth for the thesis.
 */

// ─── Public types ────────────────────────────────────────────────

export type ReferenceType = 'paper' | 'standard' | 'book' | 'web';

export interface Reference {
  /** Stable URL-safe identifier — used in deep links and the catalog map. */
  id: string;
  /**
   * APA in-text citation form WITHOUT surrounding parentheses, e.g.
   * "Brettel et al., 1997" or "WCAG 2.2 SC 1.4.3". Designed to be
   * joined with "; " and wrapped in a single outer pair of parens
   * when rendered inline in a message:
   *
   *     (Brettel et al., 1997; Sharma et al., 2005; Birch, 2012)
   */
  shortCitation: string;
  /** Full APA-style citation for hover tooltips and references panels. */
  fullCitation: string;
  /** DOI URL or canonical source URL — what the user clicks to read it. */
  url: string;
  /** Source type — useful for filtering and choosing a rendering style. */
  type: ReferenceType;
}

// ─── WCAG Standards ──────────────────────────────────────────────

export const WCAG_USE_OF_COLOR: Reference = {
  id: 'wcag-1-4-1',
  shortCitation: 'WCAG 2.2 SC 1.4.1',
  fullCitation:
    'World Wide Web Consortium (W3C). (2023). Web Content Accessibility Guidelines (WCAG) 2.2 — ' +
    'Success Criterion 1.4.1: Use of Color (Level A).',
  url: 'https://www.w3.org/TR/WCAG22/#use-of-color',
  type: 'standard',
};

export const WCAG_CONTRAST_MIN: Reference = {
  id: 'wcag-1-4-3',
  shortCitation: 'WCAG 2.2 SC 1.4.3',
  fullCitation:
    'World Wide Web Consortium (W3C). (2023). Web Content Accessibility Guidelines (WCAG) 2.2 — ' +
    'Success Criterion 1.4.3: Contrast (Minimum) (Level AA).',
  url: 'https://www.w3.org/TR/WCAG22/#contrast-minimum',
  type: 'standard',
};

export const WCAG_CONTRAST_ENHANCED: Reference = {
  id: 'wcag-1-4-6',
  shortCitation: 'WCAG 2.2 SC 1.4.6',
  fullCitation:
    'World Wide Web Consortium (W3C). (2023). Web Content Accessibility Guidelines (WCAG) 2.2 — ' +
    'Success Criterion 1.4.6: Contrast (Enhanced) (Level AAA).',
  url: 'https://www.w3.org/TR/WCAG22/#contrast-enhanced',
  type: 'standard',
};

export const WCAG_NON_TEXT_CONTRAST: Reference = {
  id: 'wcag-1-4-11',
  shortCitation: 'WCAG 2.2 SC 1.4.11',
  fullCitation:
    'World Wide Web Consortium (W3C). (2023). Web Content Accessibility Guidelines (WCAG) 2.2 — ' +
    'Success Criterion 1.4.11: Non-Text Contrast (Level AA).',
  url: 'https://www.w3.org/TR/WCAG22/#non-text-contrast',
  type: 'standard',
};

// ─── Color Vision Deficiency: simulation and prevalence ──────────

export const BRETTEL_1997: Reference = {
  id: 'brettel-vienot-mollon-1997',
  shortCitation: 'Brettel et al., 1997',
  fullCitation:
    'Brettel, H., Viénot, F., & Mollon, J. D. (1997). ' +
    'Computerized simulation of color appearance for dichromats. ' +
    'Journal of the Optical Society of America A, 14(10), 2647–2655.',
  url: 'https://doi.org/10.1364/JOSAA.14.002647',
  type: 'paper',
};

export const MACHADO_2009: Reference = {
  id: 'machado-2009',
  shortCitation: 'Machado et al., 2009',
  fullCitation:
    'Machado, G. M., Oliveira, M. M., & Fernandes, L. A. F. (2009). ' +
    'A physiologically-based model for simulation of color vision deficiency. ' +
    'IEEE Transactions on Visualization and Computer Graphics, 15(6), 1291–1298.',
  url: 'https://doi.org/10.1109/TVCG.2009.113',
  type: 'paper',
};

export const BIRCH_2012: Reference = {
  id: 'birch-2012',
  shortCitation: 'Birch, 2012',
  fullCitation:
    'Birch, J. (2012). Worldwide prevalence of red-green color deficiency. ' +
    'Journal of the Optical Society of America A, 29(3), 313–320.',
  url: 'https://doi.org/10.1364/JOSAA.29.000313',
  type: 'paper',
};

export const SHARMA_CVD_2023: Reference = {
  id: 'sharma-cvd-2023',
  shortCitation: 'Sharma, 2023',
  fullCitation:
    'Sharma, S. (2023). Unraveling the impact of color selection on data ' +
    'visualization accessibility: A colorblind perspective.',
  url: 'https://doi.org/10.58445/rars.610',
  type: 'paper',
};

// ─── Color difference metrics ────────────────────────────────────

export const SHARMA_CIEDE_2005: Reference = {
  id: 'sharma-ciede2000-2005',
  shortCitation: 'Sharma et al., 2005',
  fullCitation:
    'Sharma, G., Wu, W., & Dalal, E. N. (2005). ' +
    'The CIEDE2000 color-difference formula: Implementation notes, supplementary ' +
    'test data, and mathematical observations. Color Research & Application, 30(1), 21–30.',
  url: 'https://doi.org/10.1002/col.20070',
  type: 'paper',
};

// ─── Color map design and perceptual uniformity ──────────────────

export const BORLAND_TAYLOR_2007: Reference = {
  id: 'borland-taylor-2007',
  shortCitation: 'Borland & Taylor II, 2007',
  fullCitation:
    'Borland, D., & Taylor II, R. M. (2007). Rainbow color map (still) considered harmful. ' +
    'IEEE Computer Graphics and Applications, 27(2), 14–17.',
  url: 'https://doi.org/10.1109/MCG.2007.323435',
  type: 'paper',
};

export const CRAMERI_2020: Reference = {
  id: 'crameri-shephard-heron-2020',
  shortCitation: 'Crameri et al., 2020',
  fullCitation:
    'Crameri, F., Shephard, G. E., & Heron, P. J. (2020). ' +
    'The misuse of colour in science communication. Nature Communications, 11(1), 5444.',
  url: 'https://doi.org/10.1038/s41467-020-19160-7',
  type: 'paper',
};

export const MORELAND_2009: Reference = {
  id: 'moreland-2009',
  shortCitation: 'Moreland, 2009',
  fullCitation:
    'Moreland, K. (2009). Diverging color maps for scientific visualization. ' +
    'In G. Bebis et al. (Eds.), Advances in Visual Computing ' +
    '(Lecture Notes in Computer Science, Vol. 5876, pp. 92–103). Springer.',
  url: 'https://doi.org/10.1007/978-3-642-10520-3_9',
  type: 'paper',
};

export const NUNEZ_2018: Reference = {
  id: 'nunez-anderton-renslow-2018',
  shortCitation: 'Nuñez et al., 2018',
  fullCitation:
    'Nuñez, J. R., Anderton, C. R., & Renslow, R. S. (2018). ' +
    'Optimizing colormaps with consideration for color vision deficiency to ' +
    'enable accurate interpretation of scientific data. PLoS ONE, 13(7), e0199239.',
  url: 'https://doi.org/10.1371/journal.pone.0199239',
  type: 'paper',
};

export const SMITH_VAN_DER_WALT_2015: Reference = {
  id: 'smith-van-der-walt-2015',
  shortCitation: 'Smith & van der Walt, 2015',
  fullCitation:
    'Smith, N., & van der Walt, S. (2015). A Better Default Colormap for Matplotlib ' +
    '[Conference presentation]. SciPy 2015, Austin, TX, United States.',
  // Canonical project page (the talk itself is at https://www.youtube.com/watch?v=xAoljeRJ3lU).
  url: 'https://bids.github.io/colormap/',
  type: 'web',
};

export const BERGMAN_1995: Reference = {
  id: 'bergman-rogowitz-treinish-1995',
  shortCitation: 'Bergman et al., 1995',
  fullCitation:
    'Bergman, L. D., Rogowitz, B. E., & Treinish, L. A. (1995). ' +
    'A rule-based tool for assisting colormap selection. ' +
    'In Proceedings of Visualization \'95 (pp. 118–125). IEEE Computer Society Press.',
  url: 'https://doi.org/10.1109/VISUAL.1995.480803',
  type: 'paper',
};

// ─── Typography and readability ──────────────────────────────────

export const LEGGE_BIGELOW_2011: Reference = {
  id: 'legge-bigelow-2011',
  shortCitation: 'Legge & Bigelow, 2011',
  fullCitation:
    'Legge, G. E., & Bigelow, C. A. (2011). Does print size matter for reading? ' +
    'A review of findings from vision science and typography. Journal of Vision, 11(5), 8.',
  url: 'https://doi.org/10.1167/11.5.8',
  type: 'paper',
};

export const RELLO_2016: Reference = {
  id: 'rello-pielot-marcos-2016',
  shortCitation: 'Rello et al., 2016',
  fullCitation:
    'Rello, L., Pielot, M., & Marcos, M.-C. (2016). Make it big!: The effect of font size ' +
    'and line spacing on online readability. In Proceedings of the 2016 CHI Conference on ' +
    'Human Factors in Computing Systems (pp. 3637–3648). ACM.',
  url: 'https://doi.org/10.1145/2858036.2858204',
  type: 'paper',
};

// ─── Visualization accessibility (general) ───────────────────────

export const OSIOBE_2024: Reference = {
  id: 'osiobe-malallah-osiobe-2024',
  shortCitation: 'Osiobe et al., 2024',
  fullCitation:
    'Osiobe, E. U., Malallah, S., & Osiobe, N. E. (2024). ' +
    'Enhancing data visualization accessibility: A case for equity and inclusion. ' +
    'Open Science Framework.',
  url: 'https://doi.org/10.31219/osf.io/vjrp6',
  type: 'paper',
};

// ─── Catalog ─────────────────────────────────────────────────────

/**
 * All references collected in a single object. Useful for catalog
 * views (e.g. an "About / References" pane that lists everything),
 * for serialization, and for lookup by id.
 *
 * For rule-level usage, prefer importing the named const directly:
 *
 *     import {BRETTEL_1997} from '../references.js';
 *
 * rather than:
 *
 *     import {REFERENCES} from '../references.js';
 *     // ... REFERENCES.BRETTEL_1997
 *
 * The named-const form gives better autocomplete, better grep-ability,
 * and clearer rule files.
 */
export const REFERENCES = {
  // Standards
  WCAG_USE_OF_COLOR,
  WCAG_CONTRAST_MIN,
  WCAG_CONTRAST_ENHANCED,
  WCAG_NON_TEXT_CONTRAST,
  // CVD: simulation and prevalence
  BRETTEL_1997,
  MACHADO_2009,
  BIRCH_2012,
  SHARMA_CVD_2023,
  // Color difference
  SHARMA_CIEDE_2005,
  // Color map design
  BORLAND_TAYLOR_2007,
  CRAMERI_2020,
  MORELAND_2009,
  NUNEZ_2018,
  SMITH_VAN_DER_WALT_2015,
  BERGMAN_1995,
  // Typography
  LEGGE_BIGELOW_2011,
  RELLO_2016,
  // Visualization accessibility (general)
  OSIOBE_2024,
} as const satisfies Record<string, Reference>;

/**
 * Look up a reference by its `id` field.
 * Returns null if no reference with that id exists.
 *
 * Useful for deserialising "references this issue cites" lists
 * stored as id strings (e.g. when serialising issues to JSON).
 */
export function findReferenceById(id: string): Reference | null {
  for (const ref of Object.values(REFERENCES)) {
    if (ref.id === id) return ref;
  }
  return null;
}