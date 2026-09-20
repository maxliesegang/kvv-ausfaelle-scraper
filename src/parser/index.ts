/**
 * Main parser module for KVV cancellation detail pages.
 *
 * This module orchestrates the parsing of HTML detail pages into structured
 * cancellation data. The parser:
 * - Extracts metadata (line, timestamp, etc.)
 * - Identifies and parses trip listings
 * - Handles multiple format variations
 */

import type { Cancellation } from '../types.js';
import { classifyCauseWithEvidence } from '../cause.js';
import { toArticleText } from './article-corrections.js';
import { extractLine, extractStand } from './text-extraction.js';
import { extractTripDateAnchor } from './trip-dates.js';
import {
  extractDatedTripRows,
  extractMentionedLines,
  findUnparsedTripLikeRows,
  MultiLineMappingError,
  parseTripRow,
} from './trip-parsing.js';

/** Error thrown when the parser cannot extract any trips from an article. */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/** What one detail page yielded: its trips, plus any train number that resolved to no line. */
interface ParsedArticle {
  readonly trips: Cancellation[];
  /** Numbers a multi-line article lists that map to none of its lines. */
  readonly unmappedTrainNumbers: string[];
}

/**
 * Parses a detail page into trips, collecting rather than throwing on unmappable train numbers.
 * Both public entry points below read the same result, so the notification can never disagree
 * with the trips that were saved.
 */
function parseArticle(html: string, url: string): ParsedArticle {
  const text = toArticleText(html, url);

  // Extract metadata
  const line = extractLine(text);
  const mentionedLines = extractMentionedLines(text);
  const lineMentionCount = mentionedLines.length;
  const { standIso } = extractStand(text);
  const tripDateAnchor = extractTripDateAnchor(text);
  const datedTripRows = extractDatedTripRows(text, tripDateAnchor);
  const capturedAt = new Date().toISOString();
  const { cause, causeKeyword } = classifyCauseWithEvidence(text);

  const metadata = {
    line,
    mentionedLines,
    date: tripDateAnchor.date,
    stand: standIso,
    sourceUrl: url,
    capturedAt,
    cause,
    causeKeyword,
    lineMentionCount,
  };

  const trips: Cancellation[] = [];
  const unmappedTrainNumbers = new Set<string>();

  // Each row carries the date the list dates it to, which is the article's own day for all but
  // an after-midnight tail (see `trip-dates.ts`).
  for (const { row, date } of datedTripRows) {
    try {
      const parsed = parseTripRow(row, { ...metadata, date });
      trips.push(...parsed);
    } catch (error) {
      if (error instanceof MultiLineMappingError) {
        unmappedTrainNumbers.add(error.trainNumber);
        continue;
      }
      throw error;
    }
  }

  return { trips, unmappedTrainNumbers: Array.from(unmappedTrainNumbers) };
}

/**
 * Parses a cancellation detail page HTML into an array of Cancellation objects.
 *
 * A train number that maps to none of a multi-line article's lines does **not** fail the parse:
 * the rows that did resolve are returned, and the unmappable ones are reported separately by
 * {@link findUnmappedTrainNumbersError}. Throwing here used to discard the whole article —
 * three resolvable S1 trips were lost to one unmapped sibling in `Nettro_CMS_276842` — which
 * contradicts how a dropped known-number row is already handled: keep the good trips, raise the
 * notification alongside them.
 *
 * @param html - Raw HTML content of the detail page
 * @param url - Source URL for reference
 * @returns Array of parsed cancellations
 * @throws {ParseError} If no trips are found in the article
 */
export function parseDetailPage(html: string, url: string): Cancellation[] {
  const text = toArticleText(html, url);
  const { trips } = parseArticle(html, url);

  // Surface trip-like rows the parser silently dropped (`extractTripRows` merges/filters,
  // so an unparsable row never reaches the loop above). This only warns — the workflow
  // decides whether a dropped row is a hard error (see `findMissedKnownTripsError`), so good
  // trips are still saved when one is.
  const parsedNumbers = new Set(trips.map((trip) => trip.trainNumber));
  const unparsedTripLikeRows = findUnparsedTripLikeRows(text, parsedNumbers);
  if (unparsedTripLikeRows.length > 0) {
    console.warn(
      `  -> ${unparsedTripLikeRows.length} trip-like row(s) in ${url} matched no parser format:`,
      unparsedTripLikeRows.slice(0, 5),
    );
  }

  if (trips.length === 0) {
    throw new ParseError(`Incorrect parse: no trips were found in article ${url}`);
  }

  return trips;
}

/**
 * The notification that an article names a train number mapping to none of its lines — a real
 * cancellation filed under no line until someone adds the number to a line definition.
 *
 * Returned rather than thrown, so the caller saves the trips that *did* resolve and still fails
 * CI. This mirrors `findMissedKnownTripsError` in `workflow.ts`.
 */
export function findUnmappedTrainNumbersError(html: string, url: string): ParseError | undefined {
  const { unmappedTrainNumbers } = parseArticle(html, url);
  if (unmappedTrainNumbers.length === 0) {
    return undefined;
  }

  const text = toArticleText(html, url);
  const mentionedLines = extractMentionedLines(text);
  const linesDescription =
    mentionedLines.length > 0
      ? `${mentionedLines.length} lines: ${mentionedLines.join(', ')}`
      : 'multiple lines';
  const trainsLabel = unmappedTrainNumbers.length > 1 ? 'trains' : 'train';
  const numbersLabel =
    unmappedTrainNumbers.length > 1 ? 'these train numbers' : 'this train number';

  return new ParseError(
    `Multi-line article detected (${linesDescription}) in article ${url} ` +
      `but no train number mapping found for ${trainsLabel} ${unmappedTrainNumbers.join(', ')}. ` +
      `Please add ${numbersLabel} to the appropriate line definition.`,
  );
}

// Re-export types and utilities that may be useful for consumers
export type { StandInfo } from './text-extraction.js';
