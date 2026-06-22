/**
 * Text extraction and normalization utilities for parser.
 */

import { PATTERNS, DEFAULT_LINE } from './patterns.js';
import { ISO_DATE_LENGTH } from '../utils/constants.js';

/**
 * Strips HTML tags from a string and normalizes whitespace.
 * Converts <br> and </p> tags to line breaks before stripping.
 *
 * @param html - HTML string to strip
 * @returns Plain text with normalized line breaks
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<(li|p|div|h[1-6]|section|article)[^>]*>/gi, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/&#160;/gi, ' ')
    .replace(/&ndash;|&#8211;|–/g, '-')
    .replace(/&amp;/gi, '&')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * Parses a German datetime (DD.MM.YYYY HH:MM:SS) into ISO format.
 *
 * @param dateStr - Date string in DD.MM.YYYY format
 * @param timeStr - Time string in HH:MM:SS format
 * @returns ISO timestamp string
 */
export function parseGermanDateTime(dateStr: string, timeStr: string): string {
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
export function extractLine(text: string): string {
  const match = text.match(PATTERNS.LINE);
  return match?.[1]?.toUpperCase() ?? DEFAULT_LINE;
}

export interface StandInfo {
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
/**
 * "Stand" timestamp formats, tried in order. The alternative format omits seconds,
 * so each entry normalizes its captured time to HH:MM:SS before parsing.
 */
const STAND_FORMATS: readonly { pattern: RegExp; toTime: (time: string) => string }[] = [
  // "Nach aktuellem Stand DD.MM.YYYY HH:MM:SS"
  { pattern: PATTERNS.STAND, toTime: (time) => time },
  // "DD.MM.YYYY, HH:MM Uhr" — seconds absent, default to :00
  { pattern: PATTERNS.STAND_ALT, toTime: (time) => `${time}:00` },
];

export function extractStand(text: string): StandInfo {
  for (const { pattern, toTime } of STAND_FORMATS) {
    const match = text.match(pattern);
    const dateStr = match?.[1];
    const timeStr = match?.[2];
    if (dateStr && timeStr) {
      const standIso = parseGermanDateTime(dateStr, toTime(timeStr));
      return { standIso, dateForTrips: standIso.slice(0, ISO_DATE_LENGTH) };
    }
  }

  // Fallback to current time
  const now = new Date().toISOString();
  return {
    standIso: now,
    dateForTrips: now.slice(0, ISO_DATE_LENGTH),
  };
}
