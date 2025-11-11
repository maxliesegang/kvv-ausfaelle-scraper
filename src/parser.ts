import type { Cancellation } from './types.js';

/**
 * Regex patterns for parsing cancellation detail pages.
 */
const PATTERNS = {
  /** Matches "Linien S1 und S11" to handle combined S1/S11 lines */
  LINE_S1_S11: /Linien S1 und S11/i,

  /** Matches "Linie <line>" to extract the transit line identifier */
  LINE: /Linie\s+([A-Za-z0-9]+)/,

  /** Matches "Nach aktuellem Stand DD.MM.YYYY HH:MM:SS" to extract the status timestamp */
  STAND: /Nach aktuellem Stand\s+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}:\d{2}:\d{2})/,

  /** Matches "DD.MM.YYYY, HH:MM Uhr" alternative date format (without seconds) */
  STAND_ALT: /(\d{2}\.\d{2}\.\d{4}),\s*(\d{2}:\d{2})\s*Uhr/,

  /**
   * Matches trip format: <trainNumber> <fromStop> (<time>) - <toStop> (<time>)
   * Handles optional "Uhr" suffix after times
   * Example: "123 Karlsruhe Hbf (10:30 Uhr) - Bruchsal (11:00)"
   */
  TRIP_OLD_FORMAT:
    /^(\d+)\s+(.+?)\s+\((\d{1,2}:\d{2})(?:\s*Uhr)?\)\s*-\s*(.+?)\s+\((\d{1,2}:\d{2})(?:\s*Uhr)?\)/,

  /**
   * Matches trip format: <trainNumber> <time> Uhr <fromStop> - <time> Uhr <toStop>
   * Example: "84888 08:38 Uhr Söllingen Bahnhof - 10:07 Uhr Germersheim Bahnhof"
   */
  TRIP_NEW_FORMAT:
    /^(\d+)\s+(\d{1,2}:\d{2})(?:\s*Uhr)?\s+(.+?)\s*-\s*(\d{1,2}:\d{2})(?:\s*Uhr)?\s+(.+)/,
} as const;

/**
 * Text markers used to identify sections in the HTML.
 */
const MARKERS = {
  /** Markers that precede the list of affected trips (multiple variants) */
  TRIPS_START: [
    'sind folgende Fahrten von einem (Teil-)Ausfall betroffen:',
    'sind folgende Fahrten betroffen:',
    'Betroffene Fahrten:',
  ] as readonly string[],

  /** Marker that ends the list of affected trips */
  TRIPS_END: 'Ob deine Verbindung' as const,
};

/** Default line value when parsing fails */
const DEFAULT_LINE = 'UNKNOWN' as const;

/**
 * Strips HTML tags from a string and normalizes whitespace.
 * Converts <br> and </p> tags to line breaks before stripping.
 *
 * @param html - HTML string to strip
 * @returns Plain text with normalized line breaks
 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '')
    .trim();
}

/**
 * Parses a German datetime (DD.MM.YYYY HH:MM:SS) into ISO format.
 *
 * @param dateStr - Date string in DD.MM.YYYY format
 * @param timeStr - Time string in HH:MM:SS format
 * @returns ISO timestamp string
 */
function parseGermanDateTime(dateStr: string, timeStr: string): string {
  const dateParts = dateStr.split('.').map(Number);
  const timeParts = timeStr.split(':').map(Number);

  const day = dateParts[0] ?? 1;
  const month = dateParts[1] ?? 1;
  const year = dateParts[2] ?? new Date().getFullYear();
  const hh = timeParts[0] ?? 0;
  const mm = timeParts[1] ?? 0;
  const ss = timeParts[2] ?? 0;

  const date = new Date(year, month - 1, day, hh, mm, ss);
  return date.toISOString();
}

/**
 * Extracts the transit line identifier from the text.
 *
 * @param text - Plain text content to search
 * @returns Line identifier (uppercase) or DEFAULT_LINE if not found
 */
function extractLine(text: string): string {
  // Check for special case: S1 and S11 together (treat as S1-S11)
  if (PATTERNS.LINE_S1_S11.test(text)) {
    return 'S1-S11';
  }

  const match = text.match(PATTERNS.LINE);
  return match?.[1]?.toUpperCase() ?? DEFAULT_LINE;
}

interface StandInfo {
  /** ISO timestamp of the status */
  readonly standIso: string;
  /** ISO date (YYYY-MM-DD) extracted from the status */
  readonly dateForTrips: string;
}

/**
 * Extracts the status ("Stand") timestamp from the text.
 *
 * @param text - Plain text content to search
 * @returns Status info with ISO timestamp and date, or current time if not found
 */
function extractStand(text: string): StandInfo {
  // Try primary format: "Nach aktuellem Stand DD.MM.YYYY HH:MM:SS"
  let match = text.match(PATTERNS.STAND);

  if (match) {
    const dateStr = match[1];
    const timeStr = match[2];
    if (dateStr && timeStr) {
      const standIso = parseGermanDateTime(dateStr, timeStr);
      const dateForTrips = standIso.slice(0, 10);
      return { standIso, dateForTrips };
    }
  }

  // Try alternative format: "DD.MM.YYYY, HH:MM Uhr"
  match = text.match(PATTERNS.STAND_ALT);
  if (match) {
    const dateStr = match[1];
    const timeStr = match[2];
    if (dateStr && timeStr) {
      // Add seconds since alternative format doesn't include them
      const standIso = parseGermanDateTime(dateStr, `${timeStr}:00`);
      const dateForTrips = standIso.slice(0, 10);
      return { standIso, dateForTrips };
    }
  }

  // Fallback to current time
  const now = new Date().toISOString();
  return {
    standIso: now,
    dateForTrips: now.slice(0, 10),
  };
}

/**
 * Extracts the section of text containing trip listings.
 *
 * @param text - Full plain text content
 * @returns Array of trip lines, or empty array if section not found
 */
function extractTripLines(text: string): string[] {
  // Try each possible start marker
  // Use regex to allow flexible whitespace matching in markers
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

      // Split by lines and filter
      const rawLines = afterMarker
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => {
          if (!line) return false;
          if (line.startsWith(MARKERS.TRIPS_END)) return false;
          // Filter out lines that are clearly not trip data
          if (line === '&nbsp;') return false;
          if (line.startsWith('(Zug wird')) return false;
          if (line.includes('in Richtung') && line.includes('eingesetzt)')) return false;
          return true;
        });

      // Intelligently merge lines that are part of the same trip
      // Strategy: check if current line is valid, if not try merging with next lines
      const mergedLines: string[] = [];
      let i = 0;

      while (i < rawLines.length) {
        let combined = rawLines[i] || '';

        // Helper to check if a line would parse as a valid trip
        const isValidTrip = (line: string): boolean => {
          // Try new format
          const newMatch = line.match(PATTERNS.TRIP_NEW_FORMAT);
          if (newMatch) {
            const toStop = newMatch[5];
            const fromStop = newMatch[3];
            // Valid if stops are not just "Uhr"
            if (toStop?.trim() !== 'Uhr' && fromStop?.trim() !== 'Uhr') {
              return true;
            }
          }

          // Try old format
          const oldMatch = line.match(PATTERNS.TRIP_OLD_FORMAT);
          if (oldMatch) {
            return true;
          }

          return false;
        };

        // First check if the current line by itself is already a valid trip
        if (isValidTrip(combined)) {
          mergedLines.push(combined);
          i++;
          continue;
        }

        // If not, try merging with next lines until we get a valid trip line
        let merged = false;
        for (let j = i + 1; j < rawLines.length && j <= i + 3; j++) {
          const testLine = combined + ' ' + (rawLines[j] || '');

          // Check if this is a valid trip
          if (isValidTrip(testLine)) {
            mergedLines.push(testLine);
            i = j + 1; // Move past all merged lines
            merged = true;
            break;
          }

          combined = testLine;
        }

        // If we didn't find a valid merge, just add the line as-is and move on
        if (!merged) {
          mergedLines.push(rawLines[i] || '');
          i++;
        }
      }

      return mergedLines;
    }
  }

  return [];
}

/**
 * Parses a single trip line into a Cancellation object.
 *
 * @param line - Trip line text to parse
 * @param metadata - Common metadata for all trips (line, date, stand, sourceUrl, capturedAt)
 * @returns Cancellation object or null if parsing fails
 */
function parseTripLine(
  line: string,
  metadata: {
    readonly line: string;
    readonly date: string;
    readonly stand: string;
    readonly sourceUrl: string;
    readonly capturedAt: string;
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
        line: metadata.line,
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
        line: metadata.line,
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

/**
 * Parses a cancellation detail page HTML into an array of Cancellation objects.
 *
 * @param html - Raw HTML content of the detail page
 * @param url - Source URL for reference
 * @returns Array of parsed cancellations (empty if parsing fails or no trips found)
 */
export function parseDetailPage(html: string, url: string): Cancellation[] {
  const text = stripHtml(html);

  // Extract metadata
  const line = extractLine(text);
  const { standIso, dateForTrips } = extractStand(text);
  const capturedAt = new Date().toISOString();

  const metadata = {
    line,
    date: dateForTrips,
    stand: standIso,
    sourceUrl: url,
    capturedAt,
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

  return trips;
}
