/**
 * Wall-clock helpers for the timetable's local time zone.
 *
 * KVV publishes every trip time as Europe/Berlin wall clock (`05:02 Uhr`), with no offset.
 * Comparing such a time against an absolute instant therefore needs the zone applied
 * explicitly — a naive `new Date(\`${date}T${time}\`)` would silently resolve in the
 * runner's local zone, which is UTC in CI and CEST on a maintainer's machine.
 */

const BERLIN_TIME_ZONE = 'Europe/Berlin';

const berlinPartsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BERLIN_TIME_ZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK_TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

/**
 * Offset of Europe/Berlin from UTC at a given instant, in milliseconds
 * (+1h in winter, +2h during daylight saving time).
 */
function getBerlinOffsetMs(instantMs: number): number {
  const parts = berlinPartsFormatter.formatToParts(new Date(instantMs));
  const partsByType = new Map(parts.map((part) => [part.type, part.value]));
  const readPart = (type: Intl.DateTimeFormatPartTypes): number => Number(partsByType.get(type));

  // `hour` is `24` at midnight under some ICU versions in hour12:false mode; `Date.UTC`
  // normalizes that into the next day, which is exactly the intended instant.
  const berlinWallClockAsUtcMs = Date.UTC(
    readPart('year'),
    readPart('month') - 1,
    readPart('day'),
    readPart('hour'),
    readPart('minute'),
    readPart('second'),
  );
  return berlinWallClockAsUtcMs - instantMs;
}

/**
 * Reads an instant as Berlin wall clock, in the shapes the parser and storage use:
 * `date` as `YYYY-MM-DD`, `time` as `HH:MM`. Used where an article states no timestamp of its
 * own and "now" has to stand in for it — a naive `toISOString()` would yield the UTC date, which
 * is the previous day for anything published after 22:00/23:00 Berlin time.
 */
export function formatBerlinWallClock(instantMs: number): { date: string; time: string } {
  const parts = berlinPartsFormatter.formatToParts(new Date(instantMs));
  const partsByType = new Map(parts.map((part) => [part.type, part.value]));
  const readPart = (type: Intl.DateTimeFormatPartTypes): string => partsByType.get(type) ?? '';

  // `hour` is `24` at midnight under some ICU versions in hour12:false mode; normalize it to
  // `00`, which denotes the same wall clock on the same (already correct) date.
  const hour = readPart('hour') === '24' ? '00' : readPart('hour');
  return {
    date: `${readPart('year')}-${readPart('month')}-${readPart('day')}`,
    time: `${hour}:${readPart('minute')}`,
  };
}

/**
 * Converts a Berlin wall-clock date and time (`2026-07-27`, `05:02`) to an epoch timestamp.
 * Returns `NaN` for malformed input so callers can treat an unparsable time as "unknown"
 * rather than as an accidental 1970 timestamp.
 */
export function getBerlinWallClockMs(date: string, time: string): number {
  const dateMatch = ISO_DATE_PATTERN.exec(date);
  const timeMatch = CLOCK_TIME_PATTERN.exec(time);
  if (!dateMatch || !timeMatch) return Number.NaN;

  const naiveUtcMs = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
  );

  // The offset lookup needs an instant, but a wall clock is all we have. Resolve it twice:
  // the first pass picks the offset in effect near the target, the second re-resolves with
  // that estimate so a wall clock on the far side of a DST switch lands on the right offset.
  const estimatedInstantMs = naiveUtcMs - getBerlinOffsetMs(naiveUtcMs);
  return naiveUtcMs - getBerlinOffsetMs(estimatedInstantMs);
}
