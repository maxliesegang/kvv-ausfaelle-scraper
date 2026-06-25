/**
 * Cancellation cause classification.
 *
 * KVV cancellation notices are written by humans and the wording varies, but the
 * underlying reason almost always falls into a small set of categories. Rather than
 * filtering articles by cause (which risks dropping real cancellations), we keep every
 * cancellation and attach a best-effort category so consumers can filter downstream.
 *
 * The classifier is intentionally a simple ordered keyword match: the first category
 * whose keywords appear in the (normalized) text wins. Order encodes priority for
 * notices that mention several causes — specific causes (strike, weather, technical,
 * explicit personnel shortages) outrank the broad `betriebsbedingt` (`operational`),
 * which in turn outranks the very broad construction term `sperrung`.
 *
 * Extending it is deliberately trivial: add a keyword to an existing group, or add a
 * new `{ cause, keywords }` entry in the desired priority position.
 */

import { normalizeGermanText } from './utils/normalization.js';

/** Best-effort category for why a trip was cancelled. */
export type CancellationCause =
  | 'personnel'
  | 'operational'
  | 'strike'
  | 'technical'
  | 'weather'
  | 'construction'
  | 'unknown';

interface CauseClassifier {
  readonly cause: Exclude<CancellationCause, 'unknown'>;
  /** Keywords in normalized form (umlauts expanded to ae/oe/ue, see normalizeGermanText). */
  readonly keywords: readonly string[];
}

/**
 * Ordered by priority — first match wins. Keep specific causes above generic ones:
 * `streik`, weather/technical terms, and explicit personnel shortages (`personalmangel`,
 * `krankheit…`) are unambiguous; `betriebsbedingt` (`operational`) is the generic
 * operational catch-all KVV uses for these notices and sits just above construction terms
 * like `sperrung`, which are the broadest and so come last.
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
    cause: 'personnel',
    keywords: [
      'personalmangel',
      'personalausfall',
      'krankheitsbedingt',
      'krankheitsausfall',
      'erkrankung',
      'fahrpersonal',
    ],
  },
  {
    cause: 'operational',
    keywords: ['betriebsbedingt'],
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
