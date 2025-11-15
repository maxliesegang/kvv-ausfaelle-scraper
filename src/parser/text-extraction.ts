/**
 * Text extraction and normalization utilities for parser.
 */

import { PATTERNS, DEFAULT_LINE } from './patterns.js';

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
export function extractStand(text: string): StandInfo {
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
