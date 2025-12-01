import type { Cancellation, Item } from './types.js';
import { RSS_URL } from './config.js';
import { fetchText, parseRss } from './rss.js';
import { parseDetailPage, ParseError } from './parser/index.js';
import {
  createTrainLineObservationRecorder,
  updateTrainLineDefinitionsFromObservations,
} from './train-line-observations.js';

/** Search strings to identify relevant RSS items (case-insensitive matching) */
const RELEVANT_TITLE_MARKERS = [
  'betriebsbedingte fahrtausfälle',
  'betriebsbedingter ausfall',
] as const;

/**
 * Determines if an RSS item is relevant (contains cancellation information).
 * Uses case-insensitive matching for better reliability.
 *
 * @param item - RSS feed item to check
 * @returns true if the item contains operational cancellations
 */
export function isRelevant(item: Item): boolean {
  if (!item.title) return false;
  const titleLower = item.title.toLowerCase();
  return RELEVANT_TITLE_MARKERS.some((marker) => titleLower.includes(marker));
}

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
  return items.filter(isRelevant);
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
  try {
    const html = await fetchText(url);
    const { observations, record } = createTrainLineObservationRecorder();
    const trips = parseDetailPage(html, url, {
      onTrainLineObserved: record,
    });
    await updateTrainLineDefinitionsFromObservations(observations);
    console.log(`  -> parsed ${trips.length} trips`);
    return trips;
  } catch (error) {
    if (error instanceof ParseError) {
      // Surface incorrect parses so CI fails loudly
      throw error;
    }
    console.warn('Failed to fetch detail page:', url, error);
    return [];
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
