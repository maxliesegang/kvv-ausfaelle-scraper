/**
 * Article-scoped repairs for corrupt source text, applied before parsing.
 *
 * KVV writes these notices by hand, so a published row occasionally carries a typo that no
 * parser format can cover — not an unsupported layout, but a malformed value. The parser
 * rightly drops such a row, which silently costs a real cancellation: the notice's other trips
 * are published and the broken one simply is not, with nothing in the data saying so.
 *
 * This module repairs the *text* rather than the parsed `Cancellation`, so every path that
 * reads the article — a live run, the corpus tests, `scripts/reparse-archives.ts` — produces
 * the same trips. Patching the parsed object (or the stored JSON) instead would make the trip
 * depend on which path produced it, and a later reparse would drop it again.
 *
 * The text archive is deliberately **not** corrected: `docs/<year>/articles/<id>.txt` stays a
 * faithful copy of what KVV published, so the correction is always visible as a difference
 * between the archive and the parsed output rather than rewriting history.
 *
 * ## Admission bar
 *
 * An entry is admissible only when an external source resolves the corrupt value to a *unique*
 * answer, and the evidence is recorded in the entry's comment. If a typo has two plausible
 * readings, it does not belong here — leave the row unparsed rather than publish a guess. This
 * is an escape hatch for a handful of one-off KVV mistakes, not a general repair layer:
 * corrections are scoped to a single article by its `detailID`, so the same wording elsewhere is
 * never silently rewritten.
 */

import { extractDetailId } from '../utils/normalization.js';
import { stripHtml } from './text-extraction.js';

/** One repair: an exact source substring and its corrected form. */
interface ArticleCorrection {
  /** Literal text as KVV published it. Matched exactly, so it cannot fire by accident. */
  readonly find: string;
  /** Corrected text, justified by the evidence noted above the entry. */
  readonly replace: string;
}

/** Corrections keyed by the article's KVV `detailID`. */
const ARTICLE_CORRECTIONS: Readonly<Record<string, readonly ArticleCorrection[]>> = {
  // S5 AVG cancellations, 2026-07-24. The arrival time of train 84809 is published as
  // "09:009", which matches no clock format, so the row is dropped and the cancellation is
  // lost while the notice's other three trips are published. GTFS resolves it uniquely: every
  // run of short name 84809 leaving Wörth Badepark at 08:05 towards Söllingen arrives 09:09
  // (the other 84809 runs from that stop end at Knielingen Rheinbergstraße 08:20 and Durlach
  // Turmberg 08:54, so neither the stop nor the departure time is ambiguous). Note the
  // truncating reading — "09:00" — would be wrong by nine minutes.
  Nettro_CMS_273228: [
    { find: 'Söllingen Bahnhof 09:009 Uhr', replace: 'Söllingen Bahnhof 09:09 Uhr' },
  ],
};

/**
 * Applies the corrections registered for an article, if any.
 *
 * @param text - Plain article text, as extracted from the detail page or the archive
 * @param url - Source URL; its `detailID` scopes which corrections apply
 * @returns The text with this article's corrections applied — unchanged for every other article
 */
export function applyArticleCorrections(text: string, url: string): string {
  const corrections = ARTICLE_CORRECTIONS[extractDetailId(url) ?? ''];
  if (corrections === undefined) {
    return text;
  }

  return corrections.reduce(
    (corrected, { find, replace }) => corrected.replaceAll(find, replace),
    text,
  );
}

/**
 * The canonical plain text of an article: HTML stripped, then this article's corrections applied.
 *
 * Every consumer that reasons about trips — `parseDetailPage`, the parser-gap check in
 * `workflow.ts`, the reparse tooling — must go through this, so they all judge the same text. A
 * caller stripping HTML without correcting would re-report a repaired row as a parser gap.
 *
 * @param html - Raw detail-page HTML (or an archived body, which strips to itself)
 * @param url - Source URL; its `detailID` scopes which corrections apply
 */
export function toArticleText(html: string, url: string): string {
  return applyArticleCorrections(stripHtml(html), url);
}
