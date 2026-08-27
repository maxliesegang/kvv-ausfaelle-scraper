import type { CancellationCause } from './cause.js';
import type { TripVerification } from './verification/verify.js';

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

  /** Best-effort category for why the trip was cancelled (article-level). */
  readonly cause: CancellationCause;

  /**
   * Normalized keyword that drove the {@link cause} classification. `null` means evidence is
   * unavailable, either because the cause is `unknown` or because a legacy stored record predates
   * evidence capture. Kept so ambiguous categories remain auditable without re-reading the
   * article archive. See `src/cause.ts`.
   */
  readonly causeKeyword: string | null;

  /**
   * Git commit this record was recovered from, set only on entries restored by hand after they
   * were wrongly deleted. Absent on every normally captured record, which is the overwhelming
   * majority — consumers must treat it as optional.
   *
   * The record itself is the scraper's own output, restored verbatim, so this is *not* a
   * data-quality marker: it says where the bytes came back from, not that they are less
   * trustworthy. Its practical meaning is that the trip is no longer reproducible from the text
   * archive, because the source article was edited to drop it (see `docs/AGENTS.md`).
   */
  readonly restoredFrom?: string;

  /**
   * Advisory result of checking external realtime feeds for whether this trip actually ran.
   * Absent until `scripts/verify-trips.ts` has looked at the record, and absent forever on trips
   * older than every provider's rolling lookback window.
   *
   * This never changes what the record *means*. A stored cancellation states "KVV announced this
   * trip would not run", which stays true regardless of what the train did; verification adds the
   * separate fact "it did / did not actually run". Keeping both is the point — the disagreement
   * between them is the signal, so verification must never rewrite or delete trip identity.
   */
  readonly verification?: TripVerification;
}

/**
 * Metadata context used during trip parsing.
 * This includes both required fields and optional callbacks.
 */
export interface TripParsingMetadata {
  /** Transit line identifier */
  readonly line: string;
  /** ISO date (YYYY-MM-DD) the trip being parsed departs on (see `parser/trip-dates.ts`) */
  readonly date: string;
  /** ISO timestamp of "Stand" (status timestamp from source) */
  readonly stand: string;
  /** Original source URL */
  readonly sourceUrl: string;
  /** ISO timestamp when captured */
  readonly capturedAt: string;
  /** Best-effort cause category for the article (applied to every trip it lists) */
  readonly cause: CancellationCause;
  /** Normalized keyword behind {@link cause} (`null` when `unknown`); stamped on every trip */
  readonly causeKeyword: string | null;
  /** Lines explicitly mentioned in the article */
  readonly mentionedLines: readonly string[];
  /** Count of distinct lines mentioned */
  readonly lineMentionCount: number;
  /** Whether the line was explicitly provided in the trip line itself (line-prefix format) */
  readonly lineExplicitlyProvided?: boolean;
}

/**
 * Re-export upstream rss-parser item type for direct use across the app.
 * This represents a single RSS feed item.
 */
export type { Item } from 'rss-parser';
