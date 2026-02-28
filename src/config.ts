/**
 * Centralized application configuration with sensible defaults and environment variable overrides.
 * @module config
 */

import { FETCH_TIMEOUT } from './utils/constants.js';

/**
 * Configuration interface with validated values.
 */
export interface AppConfig {
  /** RSS feed URL to fetch cancellation notices from */
  readonly rssUrl: string;
  /**
   * Directory where JSON output is written.
   * GitHub Pages serves this directory as the site root.
   */
  readonly dataDir: string;
  /**
   * Network timeout for fetch requests in milliseconds.
   * Must be between 1000ms (1 second) and 120000ms (2 minutes).
   */
  readonly fetchTimeoutMs: number;
}

/**
 * Validates and parses a timeout value from environment variable.
 * @throws Error if timeout is invalid or out of range
 */
function validateTimeout(value: string | undefined, defaultValue: number): number {
  const raw = value ?? String(defaultValue);
  const parsed = Number(raw);

  if (Number.isNaN(parsed)) {
    throw new Error(
      `Invalid FETCH_TIMEOUT_MS: "${raw}" is not a valid number. Must be a positive integer between ${FETCH_TIMEOUT.MIN} and ${FETCH_TIMEOUT.MAX}.`,
    );
  }

  if (!Number.isInteger(parsed)) {
    throw new Error(
      `Invalid FETCH_TIMEOUT_MS: ${parsed} must be an integer (no decimals allowed).`,
    );
  }

  if (parsed < FETCH_TIMEOUT.MIN) {
    throw new Error(
      `Invalid FETCH_TIMEOUT_MS: ${parsed}ms is too short. Minimum is ${FETCH_TIMEOUT.MIN}ms (1 second).`,
    );
  }

  if (parsed > FETCH_TIMEOUT.MAX) {
    throw new Error(
      `Invalid FETCH_TIMEOUT_MS: ${parsed}ms is too long. Maximum is ${FETCH_TIMEOUT.MAX}ms (2 minutes).`,
    );
  }

  return parsed;
}

/**
 * Validates a URL string is not empty.
 * @throws Error if URL is empty or whitespace-only
 */
function validateUrl(value: string | undefined, name: string, defaultValue: string): string {
  const url = (value ?? defaultValue).trim();

  if (!url) {
    throw new Error(
      `Invalid ${name}: URL cannot be empty. Please set the ${name} environment variable.`,
    );
  }

  return url;
}

/**
 * Validates a directory path is not empty.
 * @throws Error if path is empty or whitespace-only
 */
function validateDirectory(value: string | undefined, name: string, defaultValue: string): string {
  const dir = (value ?? defaultValue).trim();

  if (!dir) {
    throw new Error(
      `Invalid ${name}: Directory path cannot be empty. Please set the ${name} environment variable.`,
    );
  }

  return dir;
}

/**
 * Loads and validates application configuration.
 * @throws Error if any configuration value is invalid
 */
function loadConfig(): AppConfig {
  return {
    rssUrl: validateUrl(process.env.RSS_URL, 'RSS_URL', 'https://www.kvv.de/ticker_rss.xml'),
    dataDir: validateDirectory(process.env.DATA_DIR, 'DATA_DIR', 'docs'),
    fetchTimeoutMs: validateTimeout(process.env.FETCH_TIMEOUT_MS, FETCH_TIMEOUT.DEFAULT),
  };
}

/**
 * Validated application configuration.
 * This is initialized once at module load and will throw if validation fails.
 */
const config = loadConfig();

/** RSS feed URL to fetch cancellation notices from */
export const RSS_URL = config.rssUrl;

/**
 * Directory where JSON output is written.
 * GitHub Pages serves this directory as the site root.
 */
export const DATA_DIR = config.dataDir;

/**
 * Network timeout for fetch requests in milliseconds.
 * @default 15000 (15 seconds)
 */
export const FETCH_TIMEOUT_MS = config.fetchTimeoutMs;
