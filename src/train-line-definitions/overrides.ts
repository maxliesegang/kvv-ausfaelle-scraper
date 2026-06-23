/**
 * Curated train-number → line escape hatch, consulted at lookup time (see
 * `src/train-lines.ts`).
 *
 * The seeded GTFS lists are authoritative: a multi-line article reports a cancellation
 * under every mentioned line the number runs on, so through-running / reused numbers need
 * no entry here. This map exists only for the rare case where GTFS maps a number to NONE
 * of an article's mentioned lines (a feed gap or genuine KVV-vs-GTFS conflict that would
 * otherwise be a hard parse error). An entry forces that number onto the given line when
 * that line is mentioned by the article; unmentioned override lines are ignored.
 *
 * Keep it empty when GTFS is complete. Keyed by Fahrplan year because train numbers are
 * reassigned between years.
 */
export const TRAIN_LINE_OVERRIDES: Readonly<Record<number, Readonly<Record<string, string>>>> = {
  2026: {},
};
