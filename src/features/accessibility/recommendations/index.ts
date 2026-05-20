/**
 * recommendations/index.ts
 *
 * Public API for the trade-off-aware recommendation engine.
 *
 * The UI layer only needs these imports:
 *
 *   import {
 *     getApplicableRecommendations,
 *     describeCvdRecommendation,
 *   } from '../../features/accessibility/recommendations/index.js';
 *
 *   const recs = getApplicableRecommendations(issue, spec);
 *   for (const rec of recs) {
 *     // render { rec.label, rec.description } as a button
 *     // on click: const newSpec = rec.apply(issue, spec);
 *   }
 */

export type {
  Recommendation,
  RecommendationFamily,
  VegaLiteSpec,
} from './types.js';

export {
  getRecommendationsForRule,
  getApplicableRecommendations,
} from './registry.js';

export {
  SCHEME_CATALOG,
  findScheme,
  pickReplacementScheme,
  type SchemeEntry,
  type SchemeType,
  type HueFamily,
} from './schemeCatalog.js';

export {describeCvdRecommendation} from './colorblindSafetyRecs.js';