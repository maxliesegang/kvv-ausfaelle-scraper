/**
 * Cancellation cause classification.
 *
 * KVV cancellation notices are written by humans and the wording varies, but the
 * underlying reason almost always falls into a small set of categories. Rather than
 * filtering articles by cause (which risks dropping real cancellations), we keep every
 * cancellation and attach a best-effort category so consumers can filter downstream.
 *
 * The classifier is intentionally a simple ordered keyword match: the first category
 * whose keywords appear in the (normalized) text wins, so list order encodes priority
 * for notices that mention several causes (see {@link CAUSE_CLASSIFIERS}).
 *
 * Every classification also reports *which* keyword matched ({@link CauseClassification}).
 * That evidence is stored alongside each cancellation so the ambiguous buckets — chiefly
 * `operational` (KVV's bare `betriebsbedingt` euphemism) and `unknown` — stay auditable
 * and re-clusterable without re-reading the article archive.
 *
 * Extending it is deliberately trivial: add a keyword to an existing group, or add a
 * new `{ cause, keywords }` entry in the desired priority position.
 */

import { normalizeGermanText } from './utils/normalization.js';

/**
 * Best-effort category for why a trip was cancelled.
 *
 * The technical family is split three ways so a rolling-stock fault and an infrastructure
 * fault are distinguishable: `vehicle` (the train), `infrastructure` (track/signal/power),
 * and `technical` (a fault KVV named only generically). The staffing family is split into
 * `personnel` (KVV *named* a staffing/sickness cause — the high-precision signal) and
 * `operational` (a bare `betriebsbedingt` with no specifics — an ambiguous euphemism that
 * is often, but not provably, staffing). `disruption` is a bare `Betriebsstörung`.
 */
export type CancellationCause =
  | 'strike'
  | 'weather'
  | 'vehicle'
  | 'infrastructure'
  | 'technical'
  | 'personnel'
  | 'operational'
  | 'disruption'
  | 'construction'
  | 'unknown';

/**
 * The classified cause plus the normalized keyword that matched (`null` for `unknown`).
 *
 * Field names mirror the stored `Cancellation` (`src/types.ts`) so a classification flows
 * onto a trip without renaming — this is the one canonical "cause + evidence keyword" shape.
 */
export interface CauseClassification {
  readonly cause: CancellationCause;
  /** Normalized keyword (see {@link normalizeGermanText}) that triggered the match. */
  readonly causeKeyword: string | null;
}

interface CauseClassifier {
  readonly cause: Exclude<CancellationCause, 'unknown'>;
  /** Keywords in normalized form (umlauts expanded to ae/oe/ue, see normalizeGermanText). */
  readonly keywords: readonly string[];
}

/**
 * Ordered by priority — first match wins. The order encodes "most specific / most certain
 * cause first":
 *
 *   strike, weather        — unambiguous external causes.
 *   vehicle, infrastructure — a *named* technical fault, split by what broke.
 *   technical              — a fault KVV named only generically (`technischer Defekt`).
 *   personnel              — KVV *named* a staffing/sickness cause. Sits ABOVE `operational`
 *                            so "betriebsbedingt wegen Personalmangel" resolves to personnel.
 *   operational            — the bare `betriebsbedingt` euphemism, no specifics. The honest
 *                            residual: often staffing, but never assume it (see project docs).
 *   disruption             — a bare `Betriebsstörung`; below the named technical causes so
 *                            "Betriebsstörung wegen Fahrzeugstörung" still resolves to vehicle.
 *   construction           — broad building/closure terms (`sperrung` etc.), matched last.
 */
const CAUSE_CLASSIFIERS: readonly CauseClassifier[] = [
  {
    cause: 'strike',
    keywords: ['streik', 'arbeitskampf', 'warnstreik'],
  },
  {
    cause: 'weather',
    keywords: [
      'unwetter',
      'sturm',
      'orkan',
      'gewitter',
      'schneefall',
      'schnee und eis',
      'glaette',
      'witterung',
      'witterungsbedingt',
      'hochwasser',
    ],
  },
  {
    // A named fault on the rolling stock (the train itself). Keywords are compound nouns on
    // purpose: German declension only appends endings to a compound (Fahrzeugschaden →
    // Fahrzeugschadens), so the stem stays a substring. An adjective+noun phrase like
    // "defektes Fahrzeug" would NOT be robust — "defekten Fahrzeugs" no longer contains it —
    // so such phrasings are intentionally left to the generic `technical` bucket below.
    cause: 'vehicle',
    keywords: ['fahrzeugstoerung', 'fahrzeugschaden', 'fahrzeugdefekt', 'zugstoerung'],
  },
  {
    // A named fault on the fixed infrastructure (track, signals, power, switches).
    cause: 'infrastructure',
    keywords: [
      'stellwerkstoerung',
      'signalstoerung',
      'oberleitungsstoerung',
      'oberleitungsschaden',
      'weichenstoerung',
      'weichenschaden',
      'gleisschaden',
      'bahnuebergangsstoerung',
    ],
  },
  {
    // A technical fault KVV named only generically, without saying vehicle vs infrastructure.
    // `technisch` is the declension-robust stem: it is a substring of every adjective form
    // (technische/technischer/technischen/technisches), so `technische Störung`, `aus
    // technischen Gründen`, `technischer Defekt` etc. all match without enumerating endings.
    cause: 'technical',
    keywords: ['technisch', 'defekt'],
  },
  {
    // KVV *named* a staffing/sickness cause: the high-precision "missing personnel" signal.
    // Above `operational` so explicit wording beats the bare `betriebsbedingt` euphemism.
    cause: 'personnel',
    keywords: [
      'personalmangel',
      'personalausfall',
      'personalengpass',
      'krankheitsbedingt',
      'krankheitsausfall',
      'erkrankung',
      'fahrpersonal',
    ],
  },
  {
    // The bare `betriebsbedingt` euphemism with no further specifics. Deliberately NOT merged
    // with `personnel`: it is often staffing, but KVV did not say so, and inferring it would
    // fabricate a signal. Kept as the honest ambiguous residual.
    cause: 'operational',
    keywords: ['betriebsbedingt'],
  },
  {
    // Unspecified acute operational disruption (`Betriebsstörung`): KVV reports a disruption
    // without naming its cause. Below the named technical causes so a named fault still wins.
    cause: 'disruption',
    keywords: ['betriebsstoerung'],
  },
  {
    cause: 'construction',
    keywords: [
      'wegen bauarbeiten',
      'bauarbeiten',
      'baustelle',
      'baubedingt',
      'baumassnahme',
      'baumassnahmen',
      'gleisbauarbeiten',
      'gleisarbeiten',
      'gleiserneuerung',
      'instandhaltung',
      'instandhaltungsarbeiten',
      'kanalsanierung',
      'kanalsanierungsarbeiten',
      'sperrung',
      'gesperrt',
      'sperrt',
    ],
  },
];

/**
 * Classifies the cause of a cancellation from free article text, reporting both the category
 * and the keyword that matched.
 *
 * @param text - Raw (un-normalized) article text; normalization is applied internally.
 * @returns The first matching {@link CauseClassification}, or `{ cause: 'unknown', causeKeyword: null }`
 *   if none match. A growing share of `'unknown'` is a useful signal that the keyword lists
 *   need extending — prefer adding keywords over widening existing ones.
 */
export function classifyCauseWithEvidence(text: string): CauseClassification {
  const normalized = normalizeGermanText(text);
  for (const { cause, keywords } of CAUSE_CLASSIFIERS) {
    const causeKeyword = keywords.find((k) => normalized.includes(k));
    if (causeKeyword !== undefined) {
      return { cause, causeKeyword };
    }
  }
  return { cause: 'unknown', causeKeyword: null };
}

/**
 * Thin accessor over {@link classifyCauseWithEvidence} for callers that only need the
 * category (e.g. relevance/skip decisions).
 */
export function classifyCause(text: string): CancellationCause {
  return classifyCauseWithEvidence(text).cause;
}
