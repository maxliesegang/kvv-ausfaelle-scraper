/**
 * Centralized application configuration with sensible defaults and environment variable overrides.
 * @module config
 */

/** RSS feed URL to fetch cancellation notices from */
export const RSS_URL = process.env.RSS_URL ?? 'https://www.kvv.de/ticker_rss.xml';

/**
 * Directory where JSON output is written.
 * GitHub Pages serves this directory as the site root.
 */
export const DATA_DIR = process.env.DATA_DIR ?? 'docs';

/**
 * Network timeout for fetch requests in milliseconds.
 * @default 15000 (15 seconds)
 */
export const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 15000);
