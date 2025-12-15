/**
 * German Fahrplan (train schedule) period definitions and utilities.
 * Fahrplan years differ from calendar years - they typically run from
 * mid-December to mid-December.
 */

export interface FahrplanPeriod {
  readonly year: number;
  readonly season: 'Winter' | 'Sommer';
  readonly startDate: string; // ISO date: YYYY-MM-DD
  readonly endDate: string; // ISO date: YYYY-MM-DD
}

export interface FahrplanYear {
  readonly year: number;
  readonly startDate: string; // ISO date: YYYY-MM-DD
  readonly endDate: string; // ISO date: YYYY-MM-DD
  readonly periods: readonly FahrplanPeriod[];
}

/**
 * Fahrplan year definitions for German train schedules.
 * Each Fahrplan year consists of Winter and Summer periods.
 */
export const FAHRPLAN_YEARS: readonly FahrplanYear[] = [
  {
    year: 2024,
    startDate: '2023-12-10',
    endDate: '2024-12-14',
    periods: [
      {
        year: 2024,
        season: 'Winter',
        startDate: '2023-12-10',
        endDate: '2024-06-14',
      },
      {
        year: 2024,
        season: 'Sommer',
        startDate: '2024-06-15',
        endDate: '2024-12-14',
      },
    ],
  },
  {
    year: 2025,
    startDate: '2024-12-15',
    endDate: '2025-12-13',
    periods: [
      {
        year: 2025,
        season: 'Winter',
        startDate: '2024-12-15',
        endDate: '2025-06-14',
      },
      {
        year: 2025,
        season: 'Sommer',
        startDate: '2025-06-15',
        endDate: '2025-12-13',
      },
    ],
  },
  {
    year: 2026,
    startDate: '2025-12-14',
    endDate: '2026-12-12',
    periods: [
      {
        year: 2026,
        season: 'Winter',
        startDate: '2025-12-14',
        endDate: '2026-06-13',
      },
      {
        year: 2026,
        season: 'Sommer',
        startDate: '2026-06-14',
        endDate: '2026-12-12',
      },
    ],
  },
  {
    year: 2027,
    startDate: '2026-12-13',
    endDate: '2027-12-11',
    periods: [
      {
        year: 2027,
        season: 'Winter',
        startDate: '2026-12-13',
        endDate: '2027-06-12',
      },
      {
        year: 2027,
        season: 'Sommer',
        startDate: '2027-06-13',
        endDate: '2027-12-11',
      },
    ],
  },
];

/**
 * Determines which Fahrplan year a given date belongs to.
 *
 * @param date - ISO date string (YYYY-MM-DD) or Date object
 * @returns The Fahrplan year (e.g., 2025), or undefined if date is outside known periods
 */
export function getFahrplanYear(date: string | Date): number | undefined {
  const isoDate = typeof date === 'string' ? date : date.toISOString().slice(0, 10);

  for (const fahrplanYear of FAHRPLAN_YEARS) {
    if (isoDate >= fahrplanYear.startDate && isoDate <= fahrplanYear.endDate) {
      return fahrplanYear.year;
    }
  }

  return undefined;
}

/**
 * Gets the current Fahrplan year based on today's date.
 *
 * @returns The current Fahrplan year, or undefined if not in a known period
 */
export function getCurrentFahrplanYear(): number | undefined {
  return getFahrplanYear(new Date());
}

/**
 * Determines which Fahrplan period (Winter/Summer) a given date belongs to.
 *
 * @param date - ISO date string (YYYY-MM-DD) or Date object
 * @returns The Fahrplan period, or undefined if date is outside known periods
 */
export function getFahrplanPeriod(date: string | Date): FahrplanPeriod | undefined {
  const isoDate = typeof date === 'string' ? date : date.toISOString().slice(0, 10);

  for (const fahrplanYear of FAHRPLAN_YEARS) {
    for (const period of fahrplanYear.periods) {
      if (isoDate >= period.startDate && isoDate <= period.endDate) {
        return period;
      }
    }
  }

  return undefined;
}

/**
 * Gets the Fahrplan year definition for a specific year.
 *
 * @param year - The Fahrplan year number
 * @returns The Fahrplan year definition, or undefined if not found
 */
export function getFahrplanYearDefinition(year: number): FahrplanYear | undefined {
  return FAHRPLAN_YEARS.find((fy) => fy.year === year);
}
