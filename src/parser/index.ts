/**
 * Main parser module for KVV cancellation detail pages.
 *
 * This module orchestrates the parsing of HTML detail pages into structured
 * cancellation data. The parser:
 * - Extracts metadata (line, timestamp, etc.)
 * - Identifies and parses trip listings
 * - Handles multiple format variations
 * - Supports train-to-line mapping observations
 */

import type { Cancellation } from '../types.js';
import { stripHtml, extractLine, extractStand } from './text-extraction.js';
import { extractMentionedLines, extractTripLines, parseTripLine } from './trip-parsing.js';

export interface ParseDetailOptions {
  readonly onTrainLineObserved?: (line: string, trainNumber: string) => void;
}

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
 * @param options - Optional callbacks and configuration
 * @returns Array of parsed cancellations (empty if parsing fails or no trips found)
 * @throws Error if no trips are found in the article
 */
export function parseDetailPage(
  html: string,
  url: string,
  options?: ParseDetailOptions,
): Cancellation[] {
  const text = stripHtml(html);

  // Extract metadata
  const line = extractLine(text);
  const mentionedLines = extractMentionedLines(text);
  const lineMentionCount = mentionedLines.length;
  const { standIso, dateForTrips } = extractStand(text);
  const capturedAt = new Date().toISOString();

  const metadata = {
    line,
    mentionedLines,
    date: dateForTrips,
    stand: standIso,
    sourceUrl: url,
    capturedAt,
    lineMentionCount,
    ...(options?.onTrainLineObserved ? { onTrainLineObserved: options.onTrainLineObserved } : {}),
  };

  // Extract and parse trip lines
  const tripLines = extractTripLines(text);
  const trips: Cancellation[] = [];

  for (const tripLine of tripLines) {
    const trip = parseTripLine(tripLine, metadata);
    if (trip) {
      trips.push(trip);
    }
  }

  if (trips.length === 0) {
    throw new ParseError(`Incorrect parse: no trips were found in article ${url}`);
  }

  return trips;
}

// Re-export types and utilities that may be useful for consumers
export type { StandInfo } from './text-extraction.js';
export type { ParseDetailOptions as ParserOptions };
