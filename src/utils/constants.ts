/**
 * Shared constants used throughout the application.
 */

/**
 * ISO date format length (YYYY-MM-DD)
 */
export const ISO_DATE_LENGTH = 10;

/**
 * ISO year format length (YYYY)
 */
export const ISO_YEAR_LENGTH = 4;

/**
 * Maximum number of consecutive lines to attempt combining when parsing trip entries.
 * Based on observed KVV HTML formatting where trip data can span up to 3 lines.
 */
export const MAX_LINES_TO_COMBINE = 3;

/**
 * Fetch timeout bounds in milliseconds
 */
export const FETCH_TIMEOUT = {
  MIN: 1000, // 1 second
  MAX: 120000, // 2 minutes
  DEFAULT: 15000, // 15 seconds
} as const;
