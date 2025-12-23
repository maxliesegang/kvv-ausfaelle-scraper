import type { Cancellation, Item } from './types.js';
import { RSS_URL } from './config.js';
import { fetchText, parseRss } from './rss.js';
import { parseDetailPage, ParseError } from './parser/index.js';
import { extractTripSectionCandidates } from './parser/trip-parsing.js';
import { stripHtml } from './parser/text-extraction.js';
import {
  createTrainLineObservationRecorder,
  updateTrainLineDefinitionsFromObservations,
} from './train-line-observations.js';
import { analyzeDetailPage, analyzeRssItem } from './relevance.js';

const MIN_ARTICLE_AGE_MS = 60 * 60 * 1000; // 1 hour
const TRIP_TIME_PAIR_PATTERN = /\d{1,2}:\d{2}.*\d{1,2}:\d{2}/;

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
 * Fetches and parses cancellation details from a single RSS item.
 *
 * @param item - RSS feed item to process
 * @returns Array of parsed cancellations (empty if no link or parsing fails)
 */
export async function fetchTripsFromItem(item: Item): Promise<Cancellation[]> {
  const url = item.link;
  if (!url) {
    return [];
  }

  console.log('Fetching detail:', url);

  let html: string;
  try {
    html = await fetchText(url);
  } catch (error) {
    console.warn('Failed to fetch detail page:', url, error);
    return [];
  }

  const detailRelevance = analyzeDetailPage(html);
  if (!detailRelevance.isRelevant) {
    const reason = detailRelevance.reasons.join('; ') || 'no cancellation signals found';
    console.warn(`  -> skipping article due to low relevance (${reason})`);
    return [];
  }

  const publishedMs = getArticlePublishedMs(item);
  if (publishedMs !== undefined) {
    const ageMs = Date.now() - publishedMs;
    if (ageMs < MIN_ARTICLE_AGE_MS) {
      const ageMinutes = Math.floor(ageMs / 60_000);
      console.log(
        `  -> skipping article because it is only ${ageMinutes} minutes old (needs 60 minutes)`,
      );
      return [];
    }
  }

  const { observations, record } = createTrainLineObservationRecorder();

  try {
    const trips = parseDetailPage(html, url, {
      onTrainLineObserved: record,
    });
    await updateTrainLineDefinitionsFromObservations(observations);
    console.log(`  -> parsed ${trips.length} trips`);
    return trips;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof ParseError && message.includes('Incorrect parse: no trips were found')) {
      const reasons = detailRelevance.reasons.join('; ') || 'no relevance reasons recorded';
      const text = stripHtml(html);
      const tripCandidates = extractTripSectionCandidates(text);
      const hasTripLikeTimes = tripCandidates.some((line) => TRIP_TIME_PAIR_PATTERN.test(line));

      if (!hasTripLikeTimes) {
        await updateTrainLineDefinitionsFromObservations(observations);
        console.warn(
          `  -> skipping article because no trip details were listed despite relevance signals (${reasons})`,
        );
        return [];
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

  for (const res of results) {
    if (res.status === 'fulfilled') {
      cancellations.push(...res.value);
      continue;
    }

    if (res.reason instanceof ParseError) {
      parseErrors.push(res.reason);
      continue;
    }

    console.warn('Detail fetch failed:', res.reason);
  }

  return { cancellations, parseErrors };
}

function getArticlePublishedMs(item: Item): number | undefined {
  const rssDate = item.isoDate ?? item.pubDate;
  if (!rssDate) {
    return undefined;
  }

  const rssMs = Date.parse(rssDate);
  return Number.isFinite(rssMs) ? rssMs : undefined;
}
