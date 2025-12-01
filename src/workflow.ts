import type { Cancellation, Item } from './types.js';
import { RSS_URL } from './config.js';
import { fetchText, parseRss } from './rss.js';
import { parseDetailPage, ParseError } from './parser/index.js';
import {
  createTrainLineObservationRecorder,
  updateTrainLineDefinitionsFromObservations,
} from './train-line-observations.js';
import { analyzeDetailPage, analyzeRssItem } from './relevance.js';

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
      console.warn(`  -> skipping article with no trips: ${url}`);
      return [];
    }

    if (error instanceof ParseError) {
      // Surface incorrect parses so CI fails loudly
      throw error;
    }

    throw new ParseError(`Failed to parse detail page ${url}: ${message}`);
  }
}

/**
 * Collects all trip cancellations from multiple RSS items.
 * Uses Promise.allSettled to tolerate individual failures.
 *
 * @param items - Array of RSS items to process
 * @returns Combined array of all successfully parsed cancellations
 */
export async function collectTrips(items: Item[]): Promise<Cancellation[]> {
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

  if (parseErrors.length > 0) {
    const messages = parseErrors.map((err) => err.message).join('; ');
    throw new Error(`Parser errors encountered: ${messages}`);
  }

  return cancellations;
}
