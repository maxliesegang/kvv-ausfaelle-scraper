/**
 * Cancellation cause classification.
 *
 * KVV cancellation notices are written by humans and the wording varies, but the
 * underlying reason almost always falls into a small set of categories. Rather than
 * filtering articles by cause (which risks dropping real cancellations), we keep every
 * cancellation and attach a best-effort category so consumers can filter downstream.
 *
 * The classifier is intentionally a simple ordered keyword match: the first category
 * whose keywords appear in the (normalized) text wins, so category order encodes priority
 * for notices that mention several causes (see {@link CANCELLATION_CAUSE_DEFINITIONS}). Within
 * that category, the longest matching keyword is retained as the most specific evidence.
 *
 * Every classification also reports *which* keyword matched ({@link CauseClassification}).
 * That evidence is stored alongside each cancellation so the ambiguous buckets — chiefly
 * `operational` (KVV's bare `betriebsbedingt` euphemism) and `unknown` — stay auditable
 * and re-clusterable without re-reading the article archive.
 *
 * Extending it is deliberately trivial: add a keyword to an existing definition, or add a
 * new definition in the desired priority position. The same definitions are also projected
 * into the public root-index taxonomy consumed by downstream applications.
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
 * is often, but not provably, staffing). `emergency` covers a named emergency-services
 * intervention, while `disruption` is a bare `Betriebsstörung`.
 */
interface CauseDefinitionInput {
  readonly id: string;
  /** German display label published for data consumers. */
  readonly label: string;
  /** German explanation of the category semantics, not its implementation keywords. */
  readonly description: string;
  /** Keywords in normalized form (umlauts expanded to ae/oe/ue, see normalizeGermanText). */
  readonly keywords: readonly string[];
}

/**
 * Ordered by priority — first match wins. The order encodes "most specific / most certain
 * cause first":
 *
 *   strike, weather, emergency — unambiguous external causes.
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
const CANCELLATION_CAUSE_DEFINITIONS = [
  {
    id: 'strike',
    label: 'Streik',
    description: 'Arbeitskampf, Streik oder Warnstreik.',
    keywords: ['streik', 'arbeitskampf', 'warnstreik'],
  },
  {
    id: 'weather',
    label: 'Witterung',
    description: 'Witterungseinflüsse wie Unwetter, Sturm, Eis oder Hochwasser.',
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
    // A named emergency-services intervention is more informative than the generic
    // disruption or closure language that commonly accompanies it.
    id: 'emergency',
    label: 'Einsatz von Rettungskräften',
    description: 'Ein gemeldeter Einsatz von Feuerwehr oder anderen Rettungskräften.',
    keywords: ['feuerwehreinsatz'],
  },
  {
    // A named fault on the rolling stock (the train itself). Keywords are compound nouns on
    // purpose: German declension only appends endings to a compound (Fahrzeugschaden →
    // Fahrzeugschadens), so the stem stays a substring. An adjective+noun phrase like
    // "defektes Fahrzeug" would NOT be robust — "defekten Fahrzeugs" no longer contains it —
    // so such phrasings are intentionally left to the generic `technical` bucket below.
    id: 'vehicle',
    label: 'Fahrzeugstörung',
    description: 'Eine benannte Störung oder ein Schaden am eingesetzten Fahrzeug.',
    keywords: ['fahrzeugstoerung', 'fahrzeugschaden', 'fahrzeugdefekt', 'zugstoerung'],
  },
  {
    // A named fault on the fixed infrastructure (track, signals, power, switches).
    id: 'infrastructure',
    label: 'Infrastrukturstörung',
    description: 'Eine benannte Störung an Stellwerk, Signal, Oberleitung, Weiche oder Gleis.',
    keywords: [
      'stellwerkstoerung',
      'signalstoerung',
      'oberleitungsstoerung',
      'oberleitungsschaden',
      'weichenstoerung',
      'weichenschaden',
      'gleisschaden',
      'bahnuebergangsstoerung',
      'stellwerkausfall',
      'stellwerksstoerung',
    ],
  },
  {
    // A technical fault KVV named only generically, without saying vehicle vs infrastructure.
    // `technisch` is the declension-robust stem: it is a substring of every adjective form
    // (technische/technischer/technischen/technisches), so `technische Störung`, `aus
    // technischen Gründen`, `technischer Defekt` etc. all match without enumerating endings.
    id: 'technical',
    label: 'Technischer Defekt',
    description: 'Eine technische Störung, ohne dass Fahrzeug oder Infrastruktur benannt sind.',
    keywords: ['technisch', 'defekt'],
  },
  {
    // KVV *named* a staffing/sickness cause: the high-precision "missing personnel" signal.
    // Above `operational` so explicit wording beats the bare `betriebsbedingt` euphemism.
    id: 'personnel',
    label: 'Personalmangel',
    description: 'Ein ausdrücklich genannter Personalengpass oder krankheitsbedingter Ausfall.',
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
    id: 'operational',
    label: 'Betriebsbedingt',
    description: 'Ein betrieblicher Grund ohne zuverlässige Benennung einer konkreteren Ursache.',
    keywords: ['betriebsbedingt', 'dichte zugfolge'],
  },
  {
    // Unspecified acute operational disruption (`Betriebsstörung`): KVV reports a disruption
    // without naming its cause. Below the named technical causes so a named fault still wins.
    id: 'disruption',
    label: 'Betriebsstörung',
    description: 'Eine gemeldete Betriebsstörung ohne näher benannte Ursache.',
    keywords: ['betriebsstoerung'],
  },
  {
    id: 'construction',
    label: 'Bauarbeiten',
    description: 'Bau-, Instandhaltungs- oder Sperrmaßnahmen an der Strecke.',
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
      'weichenarbeiten',
      'instandhaltung',
      'instandhaltungsarbeiten',
      'kanalsanierung',
      'kanalsanierungsarbeiten',
      'sperrung',
      'gesperrt',
      'sperrt',
    ],
  },
  {
    id: 'unknown',
    label: 'Unbekannt',
    description: 'Aus dem Artikel konnte keine Ursache zuverlässig bestimmt werden.',
    keywords: [],
  },
] as const satisfies readonly CauseDefinitionInput[];

/** Best-effort category identifier published on every structured cancellation. */
export type CancellationCause = (typeof CANCELLATION_CAUSE_DEFINITIONS)[number]['id'];

/** Public, implementation-independent description of one cause category. */
export interface PublicCauseDefinition {
  readonly id: CancellationCause;
  readonly label: string;
  readonly description: string;
}

/**
 * Ordered public cause taxonomy for downstream consumers. Array order is the stable display
 * and classifier-priority order; internal matching keywords are deliberately not published.
 */
export const PUBLIC_CAUSE_DEFINITIONS: readonly PublicCauseDefinition[] =
  CANCELLATION_CAUSE_DEFINITIONS.map(({ id, label, description }) => ({
    id,
    label,
    description,
  }));

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

/** Returns the longest matching keyword without allocating an intermediate matches array. */
function findMostSpecificMatchingKeyword(
  normalizedText: string,
  keywords: readonly string[],
): string | undefined {
  let mostSpecific: string | undefined;
  for (const keyword of keywords) {
    if (
      normalizedText.includes(keyword) &&
      (mostSpecific === undefined || keyword.length > mostSpecific.length)
    ) {
      mostSpecific = keyword;
    }
  }
  return mostSpecific;
}

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
  for (const { id, keywords } of CANCELLATION_CAUSE_DEFINITIONS) {
    const causeKeyword = findMostSpecificMatchingKeyword(normalized, keywords);
    if (causeKeyword !== undefined) {
      return { cause: id, causeKeyword };
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
