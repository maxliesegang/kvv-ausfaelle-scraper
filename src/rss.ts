import Parser from 'rss-parser';
import type { Item } from './types.js';
import { FETCH_TIMEOUT_MS } from './config.js';

/**
 * Custom error for fetch failures with detailed context.
 */
export class FetchError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

/**
 * Fetches text content from a URL with timeout support.
 *
 * @param url - The URL to fetch
 * @param timeoutMs - Timeout in milliseconds (defaults to FETCH_TIMEOUT_MS)
 * @returns The response text
 * @throws {FetchError} If the request fails or times out
 */
export async function fetchText(
  url: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new FetchError(
        `Failed to fetch ${url}: ${res.status} ${res.statusText}`,
        url,
        res.status,
      );
    }
    return await res.text();
  } catch (error) {
    if (error instanceof FetchError) {
      throw error;
    }
    // Handle abort/timeout or other network errors
    const message = error instanceof Error ? error.message : String(error);
    throw new FetchError(`Network error fetching ${url}: ${message}`, url);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parses RSS XML string into an array of feed items.
 *
 * @param xml - The RSS XML string to parse
 * @returns Array of RSS items (empty array if feed has no items)
 * @throws {Error} If XML parsing fails
 */
export async function parseRss(xml: string): Promise<Item[]> {
  const parser = new Parser();
  const feed = await parser.parseString(xml);
  return feed.items ?? [];
}
