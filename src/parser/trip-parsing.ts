/**
 * Trip line parsing and validation utilities.
 */

import type { Cancellation, TripParsingMetadata } from '../types.js';
import { lookupLineForTrain } from '../train-lines.js';
import { normalizeLine } from '../utils/normalization.js';
import { MAX_LINES_TO_COMBINE } from '../utils/constants.js';
import {
  PATTERNS,
  MARKERS,
  DEFAULT_LINE,
  MULTI_LINE_HINT_PATTERN,
  MULTI_LINE_RANGE_PATTERN,
  LINE_MENTION_SECTION_PATTERN,
  LINE_IDENTIFIER_PATTERN,
} from './patterns.js';

/**
 * Determines whether the parsed line value looks ambiguous (e.g. "S1 und S11").
 */
export function isAmbiguousLine(line: string): boolean {
  if (!line || line === DEFAULT_LINE) return true;
  if (MULTI_LINE_HINT_PATTERN.test(line)) return true;
  if (MULTI_LINE_RANGE_PATTERN.test(line)) return true;
  return false;
}

/**
 * Resolves the effective line for a trip, falling back to train-number overrides.
 */
export function resolveLineForTrip(
  trainNumber: string,
  metadata: Pick<
    TripParsingMetadata,
    'line' | 'mentionedLines' | 'lineMentionCount' | 'onTrainLineObserved'
  >,
): string {
  const normalizedLine = normalizeLine(metadata.line) || DEFAULT_LINE;
  const isAmbiguous = isAmbiguousLine(normalizedLine);
  const hasSingleLineMention = metadata.lineMentionCount === 1;

  if (hasSingleLineMention && !isAmbiguous && normalizedLine !== DEFAULT_LINE) {
    metadata.onTrainLineObserved?.(normalizedLine, trainNumber);
    return normalizedLine;
  }

  if (metadata.lineMentionCount > 0) {
    const mapped = lookupLineForTrain(trainNumber, metadata.mentionedLines);
    if (mapped) {
      return mapped;
    }
  }

  return normalizedLine;
}

/**
 * Checks whether a line of text looks like a parsable trip entry.
 */
export function isValidTripLine(line: string): boolean {
  // Try new format first
  const newMatch = line.match(PATTERNS.TRIP_NEW_FORMAT);
  if (newMatch) {
    const toStop = newMatch[5];
    const fromStop = newMatch[3];
    if (toStop?.trim() !== 'Uhr' && fromStop?.trim() !== 'Uhr') {
      return true;
    }
  }

  // Fallback to the old "<from> (<time>) - <to> (<time>)" format
  return Boolean(line.match(PATTERNS.TRIP_OLD_FORMAT));
}

/**
 * Splits a text block into trimmed candidate lines for trip parsing.
 */
export function buildTripCandidateLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) =>
      line
        // Replace HTML entities / non-breaking spaces before trimming
        .replace(/&nbsp;/gi, ' ')
        .replace(/\u00a0/g, ' ')
        .trim(),
    )
    .filter((line) => {
      if (!line) return false;
      if (line.startsWith(MARKERS.TRIPS_END)) return false;
      if (line.startsWith('(Zug wird')) return false;
      if (line === '&nbsp;') return false;
      if (line.includes('in Richtung') && line.includes('eingesetzt)')) return false;
      return true;
    });
}

/**
 * Extracts how many distinct lines are explicitly mentioned in the article text.
 */
export function extractMentionedLines(text: string): string[] {
  const mentions = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = LINE_MENTION_SECTION_PATTERN.exec(text)) !== null) {
    const section = match[1] ?? '';
    const tokens = section.match(LINE_IDENTIFIER_PATTERN);
    if (!tokens) continue;
    for (const token of tokens) {
      mentions.add(token.toUpperCase());
    }
  }

  return Array.from(mentions);
}

/**
 * Attempts to combine a line with subsequent lines to create a valid trip line.
 * @returns Combined line and number of lines consumed, or null if no valid combination found
 */
function tryMergeWithNext(
  rawLines: string[],
  startIndex: number,
  maxLinesToCombine: number = MAX_LINES_TO_COMBINE,
): { combinedLine: string; linesConsumed: number } | null {
  let combined = rawLines[startIndex] || '';

  for (
    let offset = 1;
    offset <= maxLinesToCombine && startIndex + offset < rawLines.length;
    offset++
  ) {
    combined = `${combined} ${rawLines[startIndex + offset] || ''}`.trim();
    if (isValidTripLine(combined)) {
      return { combinedLine: combined, linesConsumed: offset + 1 };
    }
  }

  return null;
}

/**
 * Merges lines that belong together and filters out invalid ones.
 *
 * This handles cases where trip information is split across multiple lines
 * by attempting to combine up to 3 consecutive lines to form valid trip entries.
 */
export function mergeTripLines(rawLines: string[]): string[] {
  const mergedLines: string[] = [];
  let i = 0;

  while (i < rawLines.length) {
    const currentLine = rawLines[i] || '';

    // If the line is already valid, use it as-is
    if (isValidTripLine(currentLine)) {
      mergedLines.push(currentLine);
      i++;
      continue;
    }

    // Try to combine with next lines to create a valid trip line
    const mergeResult = tryMergeWithNext(rawLines, i);
    if (mergeResult) {
      mergedLines.push(mergeResult.combinedLine);
      i += mergeResult.linesConsumed;
    } else {
      // No valid combination found, skip this line
      i++;
    }
  }

  return mergedLines;
}

/**
 * Extracts the section of text containing trip listings.
 *
 * @param text - Full plain text content
 * @returns Array of trip lines, or empty array if section not found
 */
export function extractTripLines(text: string): string[] {
  const parseFromSection = (section: string): string[] => {
    const rawLines = buildTripCandidateLines(section);
    if (rawLines.length === 0) {
      return [];
    }
    return mergeTripLines(rawLines);
  };

  // Try each possible start marker using regex for flexible whitespace
  for (const marker of MARKERS.TRIPS_START) {
    // Escape special regex characters and replace spaces with \s+ to match any whitespace
    const markerRegex = new RegExp(
      marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'),
    );
    const match = text.match(markerRegex);
    if (match) {
      const startIdx = match.index! + match[0].length;
      // Get text after the start marker
      const afterMarker = text.slice(startIdx);

      const mergedLines = parseFromSection(afterMarker);
      if (mergedLines.length > 0) {
        return mergedLines;
      }
    }
  }

  // Fallback: scan the entire text for trip-looking lines
  return parseFromSection(text);
}

/**
 * Validates parsed trip fields.
 */
function isValidTripFields(
  trainNumber: string | undefined,
  fromStop: string | undefined,
  fromTime: string | undefined,
  toStop: string | undefined,
  toTime: string | undefined,
  format: 'new' | 'old',
): boolean {
  if (!trainNumber || !fromStop || !fromTime || !toStop || !toTime) {
    return false;
  }

  // New format requires stops not to be just "Uhr" (indicates incomplete line)
  if (format === 'new') {
    return toStop.trim() !== 'Uhr' && fromStop.trim() !== 'Uhr';
  }

  return true;
}

/**
 * Builds a Cancellation object from parsed trip fields.
 */
function buildCancellation(
  trainNumber: string,
  fromStop: string,
  fromTime: string,
  toStop: string,
  toTime: string,
  metadata: TripParsingMetadata,
): Cancellation {
  return {
    line: resolveLineForTrip(trainNumber, metadata),
    date: metadata.date,
    stand: metadata.stand,
    trainNumber,
    fromStop: fromStop.trim(),
    fromTime,
    toStop: toStop.trim(),
    toTime,
    sourceUrl: metadata.sourceUrl,
    capturedAt: metadata.capturedAt,
  };
}

/**
 * Parses a single trip line into a Cancellation object.
 *
 * @param line - Trip line text to parse
 * @param metadata - Common metadata for all trips
 * @returns Cancellation object or null if parsing fails
 */
export function parseTripLine(line: string, metadata: TripParsingMetadata): Cancellation | null {
  // Try new format first: <trainNumber> <time> Uhr <fromStop> - <time> Uhr <toStop>
  let match = line.match(PATTERNS.TRIP_NEW_FORMAT);
  if (match) {
    const trainNumber = match[1];
    const fromTime = match[2];
    const fromStop = match[3];
    const toTime = match[4];
    const toStop = match[5];

    if (isValidTripFields(trainNumber, fromStop, fromTime, toStop, toTime, 'new')) {
      // Type assertion is safe here because isValidTripFields ensures all are defined
      return buildCancellation(trainNumber!, fromStop!, fromTime!, toStop!, toTime!, metadata);
    }
  }

  // Try old format: <trainNumber> <fromStop> (<time>) - <toStop> (<time>)
  match = line.match(PATTERNS.TRIP_OLD_FORMAT);
  if (match) {
    const trainNumber = match[1];
    const fromStop = match[2];
    const fromTime = match[3];
    const toStop = match[4];
    const toTime = match[5];

    if (isValidTripFields(trainNumber, fromStop, fromTime, toStop, toTime, 'old')) {
      // Type assertion is safe here because isValidTripFields ensures all are defined
      return buildCancellation(trainNumber!, fromStop!, fromTime!, toStop!, toTime!, metadata);
    }
  }

  return null;
}
