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
import { TRIP_TIME_PAIR_PATTERN } from './patterns.js';
import { stripHtml, extractLine, extractStand } from './text-extraction.js';
import {
  extractMentionedLines,
  extractTripLines,
  MultiLineMappingError,
  parseTripLine,
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
  const text = stripHtml(html);

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
  const tripLines = extractTripLines(text);
  const trips: Cancellation[] = [];
  const unmappedTrainNumbers = new Set<string>();
  const unparsedTripLikeLines: string[] = [];

  for (const tripLine of tripLines) {
    try {
      const parsed = parseTripLine(tripLine, metadata);
      if (parsed.length > 0) {
        trips.push(...parsed);
      } else if (TRIP_TIME_PAIR_PATTERN.test(tripLine)) {
        // Looks like a trip (two times) but matched no known format — keep it visible
        // so a varying human-written row is not silently dropped.
        unparsedTripLikeLines.push(tripLine);
      }
    } catch (error) {
      if (error instanceof MultiLineMappingError) {
        unmappedTrainNumbers.add(error.trainNumber);
        continue;
      }
      throw error;
    }
  }

  if (unparsedTripLikeLines.length > 0) {
    console.warn(
      `  -> ${unparsedTripLikeLines.length} trip-like line(s) in ${url} matched no parser format:`,
      unparsedTripLikeLines.slice(0, 5),
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
