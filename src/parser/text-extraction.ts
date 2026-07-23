/**
 * Text extraction and normalization utilities for parser.
 */

import { PATTERNS, DEFAULT_LINE } from './patterns.js';
import { ISO_DATE_LENGTH } from '../utils/constants.js';

/** Last Sunday of a UTC month, expressed as its one-based day number. */
function getLastSundayOfMonth(year: number, monthIndex: number): number {
  const lastDayOfMonth = new Date(Date.UTC(year, monthIndex + 1, 0));
  return lastDayOfMonth.getUTCDate() - lastDayOfMonth.getUTCDay();
}

/**
 * Europe/Berlin UTC offset for the years represented by the archive corpus.
 * CEST starts at 02:00 local time on March's final Sunday and ends at 03:00
 * local time on October's final Sunday.
 */
function getBerlinUtcOffsetHours(year: number, month: number, day: number, hour: number): number {
  if (month > 3 && month < 10) return 2;
  if (month < 3 || month > 10) return 1;

  const transitionDay = getLastSundayOfMonth(year, month - 1);
  if (month === 3) {
    return day > transitionDay || (day === transitionDay && hour >= 2) ? 2 : 1;
  }
  return day < transitionDay || (day === transitionDay && hour < 3) ? 2 : 1;
}

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
  const hour = timeParts[0] ?? 0;
  const minute = timeParts[1] ?? 0;
  const second = timeParts[2] ?? 0;

  // KVV publishes Europe/Berlin wall-clock time. Convert it explicitly instead of using
  // the process-local Date constructor, which changes behavior between developer machines
  // and UTC CI. Germany observes CET (UTC+1) and CEST (UTC+2), with transitions on the
  // final Sundays of March and October.
  const utcOffsetHours = getBerlinUtcOffsetHours(year, month, day, hour);
  const utcDateTime = new Date(
    Date.UTC(year, month - 1, day, hour - utcOffsetHours, minute, second),
  );
  return utcDateTime.toISOString();
}

/** Converts DD.MM.YYYY to the trip-date shape without a timezone round-trip. */
function convertGermanDateToIsoDate(dateStr: string): string {
  const [day = '', month = '', year = ''] = dateStr.split('.');
  return `${year}-${month}-${day}`;
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
  /**
   * Whether the page actually stated a "Stand". When false, `standIso` is the
   * current-time fallback rather than a value read from the article.
   */
  readonly hasStand: boolean;
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
      return { standIso, dateForTrips: convertGermanDateToIsoDate(dateStr), hasStand: true };
    }
  }

  // Fallback to current time
  const now = new Date().toISOString();
  return {
    standIso: now,
    dateForTrips: now.slice(0, ISO_DATE_LENGTH),
    hasStand: false,
  };
}
