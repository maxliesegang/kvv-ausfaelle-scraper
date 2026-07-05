import type { Cancellation, Item } from './types.js';
import { DATA_DIR, RSS_URL } from './config.js';
import { archiveArticleText } from './article-archive.js';
import { fetchText, parseRss } from './rss.js';
import { parseDetailPage, ParseError } from './parser/index.js';
import { extractTripSectionCandidates } from './parser/trip-parsing.js';
import { TRIP_TIME_PAIR_PATTERN } from './parser/patterns.js';
import { stripHtml } from './parser/text-extraction.js';
import { classifyCause } from './cause.js';
import { analyzeDetailPage, analyzeRssItem } from './relevance.js';

const MIN_ARTICLE_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Fetches and filters the RSS feed for relevant cancellation items.
 *
 * @param rssUrl - RSS feed URL (defaults to configured RSS_URL)
 * @returns Array of relevant RSS items
 * @throws {FetchError} If fetching or parsing the RSS feed fails
 */
export async function fetchRelevantItems(rssUrl: string = RSS_URL): Promise<Item[]> {
  const rssXml = await fetchText(rssUrl);
  const items = await parseRss(rssXml);

  const scored = items.map((item) => ({ item, relevance: analyzeRssItem(item) }));
  const relevant = scored.filter(({ relevance }) => relevance.isRelevant).map(({ item }) => item);

  const skipped = scored.length - relevant.length;
  if (skipped > 0) {
    console.log(`Filtered out ${skipped} non-cancellation RSS items based on relevance scoring.`);
  }

  return relevant;
}

/**
 * Why an article produced no trips this run. Used for the per-run summary so the
 * GitHub Actions log shows at a glance how each relevant item was handled.
 */
export type SkipReason =
  | 'no-link'
  | 'fetch-failed'
  | 'low-relevance'
  | 'too-young'
  | 'no-trip-details'
  | 'construction';

/** Outcome of processing a single RSS item: either parsed trips or a skip reason. */
export type ItemOutcome =
  | { readonly status: 'parsed'; readonly trips: Cancellation[] }
  | { readonly status: 'skipped'; readonly reason: SkipReason };

function skipped(reason: SkipReason): ItemOutcome {
  return { status: 'skipped', reason };
}

/**
 * Fetches and parses cancellation details from a single RSS item.
 *
 * @param item - RSS feed item to process
 * @returns The trips parsed from the article, or the reason it produced none
 * @throws {ParseError} On a genuine parser regression (re-thrown for CI visibility)
 */
export async function fetchTripsFromItem(item: Item): Promise<ItemOutcome> {
  const url = item.link;
  if (!url) {
    return skipped('no-link');
  }

  console.log('Fetching detail:', url);

  let html: string;
  try {
    html = await fetchText(url);
  } catch (error) {
    console.warn('Failed to fetch detail page:', url, error);
    return skipped('fetch-failed');
  }

  const detailRelevance = analyzeDetailPage(html);
  if (!detailRelevance.isRelevant) {
    const reason = detailRelevance.reasons.join('; ') || 'no cancellation signals found';
    console.warn(`  -> skipping article due to low relevance (${reason})`);
    return skipped('low-relevance');
  }

  // Archive the raw article text for traceability before any skip/parse decision, so even
  // too-young or unparsable articles leave a record. Never fatal — the run must not fail
  // because we couldn't write an archive file.
  try {
    await archiveArticleText(DATA_DIR, url, html);
  } catch (error) {
    console.warn('Failed to archive article text:', url, error);
  }

  const publishedMs = getArticlePublishedMs(item);
  if (publishedMs !== undefined) {
    const ageMs = Date.now() - publishedMs;
    if (ageMs < MIN_ARTICLE_AGE_MS) {
      const ageMinutes = Math.floor(ageMs / 60_000);
      console.log(
        `  -> skipping article because it is only ${ageMinutes} minutes old (needs 60 minutes)`,
      );
      return skipped('too-young');
    }
  }

  try {
    const trips = parseDetailPage(html, url);
    console.log(`  -> parsed ${trips.length} trips`);
    return { status: 'parsed', trips };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof ParseError && message.includes('Incorrect parse: no trips were found')) {
      const reasons = detailRelevance.reasons.join('; ') || 'no relevance reasons recorded';
      const text = stripHtml(html);
      const tripCandidates = extractTripSectionCandidates(text);
      const hasTripLikeTimes = tripCandidates.some((line) => TRIP_TIME_PAIR_PATTERN.test(line));

      if (!hasTripLikeTimes) {
        console.warn(
          `  -> skipping article because no trip details were listed despite relevance signals (${reasons})`,
        );
        return skipped('no-trip-details');
      }

      // Construction notices are newly admitted (they were filtered out before cause
      // classification replaced the construction veto). We do not yet parse their trip
      // formats, so a failure here is not a regression — warn and skip instead of
      // failing CI. Any other cause is something we already parse, so stay loud.
      if (classifyCause(text) === 'construction') {
        console.warn(
          `  -> skipping construction notice with unparsed trip-like lines: ${url} (signals: ${reasons})`,
        );
        return skipped('construction');
      }

      throw new ParseError(
        `Relevant article contained no trips after parsing: ${url} (signals: ${reasons})`,
      );
    }

    if (error instanceof ParseError) {
      // Surface incorrect parses so CI fails loudly
      throw error;
    }

    throw new ParseError(`Failed to parse detail page ${url}: ${message}`);
  }
}

/**
 * Result of collecting trips from multiple RSS items.
 * Separates successful parses from errors to allow partial success.
 */
export interface CollectTripsResult {
  /** Successfully parsed trip cancellations */
  readonly cancellations: Cancellation[];
  /** Parse errors encountered (e.g., missing train number mappings) */
  readonly parseErrors: ParseError[];
}

/**
 * Collects all trip cancellations from multiple RSS items.
 * Uses Promise.allSettled to tolerate individual failures.
 *
 * This function processes all items and returns both successful results and errors,
 * allowing the caller to save valid data while still being alerted to parsing issues.
 *
 * @param items - Array of RSS items to process
 * @returns Object containing successfully parsed cancellations and any parse errors encountered
 */
export async function collectTrips(items: Item[]): Promise<CollectTripsResult> {
  const results = await Promise.allSettled(items.map((item) => fetchTripsFromItem(item)));

  const cancellations: Cancellation[] = [];
  const parseErrors: ParseError[] = [];

  // Count how each item was handled so the run summary explains where trips went.
  let parsedItems = 0;
  const skips: Record<SkipReason, number> = {
    'no-link': 0,
    'fetch-failed': 0,
    'low-relevance': 0,
    'too-young': 0,
    'no-trip-details': 0,
    construction: 0,
  };
  let unexpectedErrors = 0;

  for (const res of results) {
    if (res.status === 'fulfilled') {
      const outcome = res.value;
      if (outcome.status === 'parsed') {
        parsedItems += 1;
        cancellations.push(...outcome.trips);
      } else {
        skips[outcome.reason] += 1;
      }
      continue;
    }

    if (res.reason instanceof ParseError) {
      parseErrors.push(res.reason);
      continue;
    }

    unexpectedErrors += 1;
    console.warn('Detail fetch failed:', res.reason);
  }

  logItemOutcomes(items.length, {
    parsedItems,
    trips: cancellations.length,
    skips,
    parseErrors: parseErrors.length,
    unexpectedErrors,
  });

  return { cancellations, parseErrors };
}

interface ItemOutcomeSummary {
  readonly parsedItems: number;
  readonly trips: number;
  readonly skips: Record<SkipReason, number>;
  readonly parseErrors: number;
  readonly unexpectedErrors: number;
}

/** Human-readable labels for each skip reason, in the order shown in the summary. */
const SKIP_LABELS: Record<SkipReason, string> = {
  'too-young': 'too young (<60 min)',
  'low-relevance': 'low relevance',
  'no-trip-details': 'no trip details listed',
  construction: 'construction (unparsed)',
  'fetch-failed': 'fetch failed',
  'no-link': 'no link',
};

/** Logs a one-block breakdown of how every relevant item was handled this run. */
function logItemOutcomes(total: number, summary: ItemOutcomeSummary): void {
  // Build only the non-empty rows, then pad labels to a shared width so values align.
  const rows: Array<[label: string, value: string]> = [
    ['parsed', `${summary.parsedItems} (${summary.trips} trip(s))`],
  ];

  for (const reason of Object.keys(SKIP_LABELS) as SkipReason[]) {
    if (summary.skips[reason] > 0) {
      rows.push([SKIP_LABELS[reason], String(summary.skips[reason])]);
    }
  }
  if (summary.parseErrors > 0) {
    rows.push(['parse errors', String(summary.parseErrors)]);
  }
  if (summary.unexpectedErrors > 0) {
    rows.push(['unexpected errors', String(summary.unexpectedErrors)]);
  }

  const labelWidth = Math.max(...rows.map(([label]) => label.length)) + 1; // +1 for the colon

  console.log(`\nItem outcomes (${total} relevant item(s)):`);
  for (const [label, value] of rows) {
    console.log(`  ${`${label}:`.padEnd(labelWidth + 2)}${value}`);
  }
}

function getArticlePublishedMs(item: Item): number | undefined {
  const rssDate = item.isoDate ?? item.pubDate;
  if (!rssDate) {
    return undefined;
  }

  const rssMs = Date.parse(rssDate);
  return Number.isFinite(rssMs) ? rssMs : undefined;
}
