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
 * Extending it is deliberately trivial: add a keyword to an existing group, or add a
 * new `{ cause, keywords }` entry in the desired priority position.
 */

import { normalizeGermanText } from './utils/normalization.js';

/** Best-effort category for why a trip was cancelled. */
export type CancellationCause =
  | 'operational'
  | 'strike'
  | 'technical'
  | 'disruption'
  | 'weather'
  | 'construction'
  | 'unknown';

interface CauseClassifier {
  readonly cause: Exclude<CancellationCause, 'unknown'>;
  /** Keywords in normalized form (umlauts expanded to ae/oe/ue, see normalizeGermanText). */
  readonly keywords: readonly string[];
}

/**
 * Ordered by priority — first match wins. Keep specific, unambiguous causes (strike,
 * weather, technical) first; then `operational` (the `betriebsbedingt`/staffing
 * euphemism); then `disruption` (a bare `Betriebsstörung`, deliberately below `technical`
 * so a named fault wins); with the broad construction terms (`sperrung` etc.) last.
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
    cause: 'technical',
    keywords: [
      'fahrzeugstoerung',
      'technische stoerung',
      'technischer defekt',
      'technische gruende',
      'stellwerkstoerung',
      'signalstoerung',
      'oberleitungsstoerung',
      'oberleitungsschaden',
      'weichenstoerung',
      'defekt',
    ],
  },
  {
    // KVV's catch-all for these notices: the generic `betriebsbedingt` umbrella term
    // plus explicit personnel/staffing shortages (formerly a separate `personnel` cause).
    cause: 'operational',
    keywords: [
      'betriebsbedingt',
      'personalmangel',
      'personalausfall',
      'krankheitsbedingt',
      'krankheitsausfall',
      'erkrankung',
      'fahrpersonal',
    ],
  },
  {
    // Unspecified acute operational disruption (`Betriebsstörung`): KVV reports a
    // disruption without naming its cause. Kept distinct from `operational` (the
    // `betriebsbedingt` staffing euphemism) so it never pollutes that signal, and below
    // `technical` so a named fault ('Betriebsstörung wegen Fahrzeugstörung') still wins.
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
 * Classifies the cause of a cancellation from free article text.
 *
 * @param text - Raw (un-normalized) article text; normalization is applied internally.
 * @returns The first matching {@link CancellationCause}, or `'unknown'` if none match.
 *   A growing share of `'unknown'` is a useful signal that the keyword lists need
 *   extending — prefer adding keywords over widening existing ones.
 */
export function classifyCause(text: string): CancellationCause {
  const normalized = normalizeGermanText(text);
  for (const { cause, keywords } of CAUSE_CLASSIFIERS) {
    if (keywords.some((keyword) => normalized.includes(keyword))) {
      return cause;
    }
  }
  return 'unknown';
}
