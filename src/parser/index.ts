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
import {
  extractMentionedLines,
  extractTripRows,
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

/**
 * Parses a cancellation detail page HTML into an array of Cancellation objects.
 *
 * @param html - Raw HTML content of the detail page
 * @param url - Source URL for reference
 * @returns Array of parsed cancellations (empty if parsing fails or no trips found)
 * @throws Error if no trips are found in the article
 */
export function parseDetailPage(html: string, url: string): Cancellation[] {
  const text = toArticleText(html, url);

  // Extract metadata
  const line = extractLine(text);
  const mentionedLines = extractMentionedLines(text);
  const lineMentionCount = mentionedLines.length;
  const { standIso, dateForTrips } = extractStand(text);
  const capturedAt = new Date().toISOString();
  const { cause, causeKeyword } = classifyCauseWithEvidence(text);

  const metadata = {
    line,
    mentionedLines,
    date: dateForTrips,
    stand: standIso,
    sourceUrl: url,
    capturedAt,
    cause,
    causeKeyword,
    lineMentionCount,
  };

  // Extract and parse trip lines
  const tripRows = extractTripRows(text);
  const trips: Cancellation[] = [];
  const unmappedTrainNumbers = new Set<string>();

  for (const tripRow of tripRows) {
    try {
      const parsed = parseTripRow(tripRow, metadata);
      trips.push(...parsed);
    } catch (error) {
      if (error instanceof MultiLineMappingError) {
        unmappedTrainNumbers.add(error.trainNumber);
        continue;
      }
      throw error;
    }
  }

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

  if (unmappedTrainNumbers.size > 0) {
    const linesDescription =
      lineMentionCount > 0 && mentionedLines.length > 0
        ? `${lineMentionCount} lines: ${mentionedLines.join(', ')}`
        : 'multiple lines';
    const trains = Array.from(unmappedTrainNumbers);
    const trainsLabel = trains.length > 1 ? 'trains' : 'train';
    const numbersLabel = trains.length > 1 ? 'these train numbers' : 'this train number';

    throw new ParseError(
      `Multi-line article detected (${linesDescription}) in article ${url} ` +
        `but no train number mapping found for ${trainsLabel} ${trains.join(', ')}. ` +
        `Please add ${numbersLabel} to the appropriate line definition.`,
    );
  }

  if (trips.length === 0) {
    throw new ParseError(`Incorrect parse: no trips were found in article ${url}`);
  }

  return trips;
}

// Re-export types and utilities that may be useful for consumers
export type { StandInfo } from './text-extraction.js';
