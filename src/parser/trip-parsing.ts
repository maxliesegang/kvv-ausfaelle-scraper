/**
 * Trip line parsing and validation utilities.
 */

import type { Cancellation } from '../types.js';
import { lookupLineForTrain } from '../train-lines.js';
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
  metadata: {
    readonly line: string;
    readonly lineMentionCount: number;
    readonly onTrainLineObserved?: (line: string, trainNumber: string) => void;
  },
): string {
  const normalizedLine = metadata.line?.trim() || DEFAULT_LINE;
  const isAmbiguous = isAmbiguousLine(normalizedLine);
  const hasSingleLineMention = metadata.lineMentionCount === 1;

  if (hasSingleLineMention && !isAmbiguous && normalizedLine !== DEFAULT_LINE) {
    metadata.onTrainLineObserved?.(normalizedLine, trainNumber);
    return normalizedLine;
  }

  if (metadata.lineMentionCount > 0) {
    const mapped = lookupLineForTrain(trainNumber);
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
 * Merges lines that belong together and filters out invalid ones.
 *
 * This handles cases where trip information is split across multiple lines
 * by attempting to combine up to 3 consecutive lines to form valid trip entries.
 *
 * Algorithm:
 * 1. If current line is valid, add it and move to next
 * 2. Otherwise, try combining with next 1-3 lines
 * 3. If combination becomes valid, add it and skip merged lines
 * 4. If no valid combination found, keep the line (will be filtered later)
 */
export function mergeTripLines(rawLines: string[]): string[] {
  const mergedLines: string[] = [];
  let i = 0;

  while (i < rawLines.length) {
    let combined = rawLines[i] || '';

    if (isValidTripLine(combined)) {
      mergedLines.push(combined);
      i++;
      continue;
    }

    let merged = false;
    for (let j = i + 1; j < rawLines.length && j <= i + 3; j++) {
      const testLine = `${combined} ${rawLines[j] || ''}`.trim();
      if (isValidTripLine(testLine)) {
        mergedLines.push(testLine);
        i = j + 1;
        merged = true;
        break;
      }
      combined = testLine;
    }

    if (!merged) {
      // Keep single line even if invalid - parseTripLine will ignore it later
      mergedLines.push(rawLines[i] || '');
      i++;
    }
  }

  return mergedLines.filter(isValidTripLine);
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
 * Parses a single trip line into a Cancellation object.
 *
 * @param line - Trip line text to parse
 * @param metadata - Common metadata for all trips (line, date, stand, sourceUrl, capturedAt)
 * @returns Cancellation object or null if parsing fails
 */
export function parseTripLine(
  line: string,
  metadata: {
    readonly line: string;
    readonly date: string;
    readonly stand: string;
    readonly sourceUrl: string;
    readonly capturedAt: string;
    readonly lineMentionCount: number;
    readonly onTrainLineObserved?: (line: string, trainNumber: string) => void;
  },
): Cancellation | null {
  // Try new format first: <trainNumber> <time> Uhr <fromStop> - <time> Uhr <toStop>
  let match = line.match(PATTERNS.TRIP_NEW_FORMAT);
  if (match) {
    const trainNumber = match[1];
    const fromTime = match[2];
    const fromStop = match[3];
    const toTime = match[4];
    const toStop = match[5];

    // Ensure all required fields are present and valid
    // toStop/fromStop should not be just "Uhr" (indicates incomplete line)
    if (
      trainNumber &&
      fromStop &&
      fromTime &&
      toStop &&
      toTime &&
      toStop.trim() !== 'Uhr' &&
      fromStop.trim() !== 'Uhr'
    ) {
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
  }

  // Try old format: <trainNumber> <fromStop> (<time>) - <toStop> (<time>)
  match = line.match(PATTERNS.TRIP_OLD_FORMAT);
  if (match) {
    const trainNumber = match[1];
    const fromStop = match[2];
    const fromTime = match[3];
    const toStop = match[4];
    const toTime = match[5];

    // Ensure all required fields are present
    if (trainNumber && fromStop && fromTime && toStop && toTime) {
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
  }

  return null;
}
