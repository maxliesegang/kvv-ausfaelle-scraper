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
 * Metadata context used during trip parsing.
 * This includes both required fields and optional callbacks.
 */
export interface TripParsingMetadata {
  /** Transit line identifier */
  readonly line: string;
  /** ISO date (YYYY-MM-DD) */
  readonly date: string;
  /** ISO timestamp of "Stand" (status timestamp from source) */
  readonly stand: string;
  /** Original source URL */
  readonly sourceUrl: string;
  /** ISO timestamp when captured */
  readonly capturedAt: string;
  /** Lines explicitly mentioned in the article */
  readonly mentionedLines: readonly string[];
  /** Count of distinct lines mentioned */
  readonly lineMentionCount: number;
  /** Optional callback for recording train/line observations */
  readonly onTrainLineObserved?: (line: string, trainNumber: string) => void;
  /** Whether the line was explicitly provided in the trip line itself (line-prefix format) */
  readonly lineExplicitlyProvided?: boolean;
}

/**
 * Re-export upstream rss-parser item type for direct use across the app.
 * This represents a single RSS feed item.
 */
export type { Item } from 'rss-parser';
