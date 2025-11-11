/**
 * Represents a single trip cancellation entry.
 * All cancellations are organized by line and year in the storage layer.
 */
export interface Cancellation {
  /** Transit line identifier (e.g., "S5", "S1") */
  readonly line: string;

  /** ISO date (YYYY-MM-DD) when the cancellation occurs */
  readonly date: string;

  /** ISO timestamp of "Stand" (status timestamp from source) */
  readonly stand: string;

  /** Train/service number */
  readonly trainNumber: string;

  /** Departure stop name */
  readonly fromStop: string;

  /** Departure time (HH:mm format) */
  readonly fromTime: string;

  /** Arrival stop name */
  readonly toStop: string;

  /** Arrival time (HH:mm format) */
  readonly toTime: string;

  /** Original source URL where this cancellation was published */
  readonly sourceUrl: string;

  /** ISO timestamp when this entry was captured by the scraper */
  readonly capturedAt: string;
}

/**
 * Re-export upstream rss-parser item type for direct use across the app.
 * This represents a single RSS feed item.
 */
export type { Item } from 'rss-parser';
