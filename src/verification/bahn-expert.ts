/**
 * Read-only client for bahn.expert's tRPC gateway, used to check whether a trip KVV announced as
 * cancelled actually ran.
 *
 * Two constraints are load-bearing and non-obvious:
 *
 * 1. Inputs and outputs are `devalue`-encoded (see `./devalue.ts`). Plain JSON is rejected.
 * 2. A browser-like `User-Agent` is mandatory — with a default client UA the gateway answers
 *    `HTTP 206` with an empty body rather than an error, which reads as a successful empty result.
 *
 * The API answers for a rolling **seven days**; older instants fail outright. Realtime and
 * cancellation data survive that whole window, so verification can backfill after an outage
 * instead of only checking the trips that departed since the previous run.
 */

import { parseDevalue, stringifyDevalue } from './devalue.js';

const RPC_BASE = 'https://bahn.expert/rpc';

/**
 * bahn.expert rejects non-browser agents with an empty `206`, so a browser UA is required. The
 * trailing comment keeps the request honest about who is calling and why.
 */
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/128.0.0.0 Safari/537.36 (+kvv-ausfaelle-scraper; trip verification)';

/**
 * How far back the gateway answers. Measured, not documented: the cutoff is rolling rather than
 * calendar-day based. At 2026-08-17 21:59 UTC, 2026-08-10 21:59 UTC still worked while 19:59 UTC
 * returned 400. Keep the selection calculation instant-based so late trips on the seventh day are
 * not needlessly discarded.
 */
export const MAX_LOOKBACK_DAYS = 7;

export interface JourneyStopEvent {
  readonly scheduledTime?: string;
  readonly time?: string;
  /**
   * Present on nearly every stop, **including purely timetabled ones** where it is `0` and `time`
   * equals `scheduledTime`. It is therefore not a realtime signal — `isRealTime` is. Kept because
   * it is worth reading once a stop is known to be observed.
   */
  readonly delay?: number | null;
  /** `true` only where the feed actually observed the vehicle; `null` on timetable-only stops. */
  readonly isRealTime?: boolean | null;
  /**
   * Per-event cancellation. The feed flags a stop's arrival and departure independently, and at
   * the boundary of a partial cancellation it sets these **without** setting the stop-level flag,
   * so a reader that only looks at {@link JourneyStop.cancelled} undercounts.
   */
  readonly cancelled?: boolean | null;
  /**
   * Who runs this leg. `operatorCode` is the feed's canonical short token (`AVG`, `SNCF`, `Bus`)
   * and the most explicit statement of operator identity in the whole response — the top-level
   * `train.admin` carries only an opaque ID (`A6`, `A6S11`, `87`).
   */
  readonly transport?: {
    readonly administration?: {
      readonly administrationID?: string;
      readonly operatorCode?: string;
      readonly operatorName?: string;
    };
  };
}

export interface JourneyStop {
  readonly stopPlace?: { readonly name?: string };
  readonly arrival?: JourneyStopEvent | null;
  readonly departure?: JourneyStopEvent | null;
  readonly cancelled?: boolean | null;
}

export interface JourneyDetails {
  readonly journeyId?: string;
  readonly cancelled?: boolean | null;
  readonly stops?: readonly JourneyStop[];
  readonly train?: {
    readonly line?: string;
    readonly journeyNumber?: number;
    /**
     * Operating company, and its administration ID (`A6` for AVG, `87` for SNCF, `81` for ÖBB).
     *
     * Returned only by `journey.detailsByJourneyId` — `journey.find` omits both, which is why the
     * operator can confirm a candidate's identity but cannot pre-filter the candidate list.
     */
    readonly admin?: string;
    readonly operator?: string;
  };
}

export interface JourneyCandidate {
  readonly journeyId: string;
  readonly train?: {
    readonly line?: string;
    readonly category?: string;
    readonly transportType?: string;
  };
}

/**
 * Put likely AVG Stadtbahn results before same-number buses and trains elsewhere in Europe.
 * Ordering is only an efficiency and resilience hint: full journey details still have to pass
 * operator, number, stop-name, and schedule checks before they can produce a verdict.
 */
export function orderJourneyCandidates(
  candidates: readonly JourneyCandidate[],
  expectedLine: string,
): JourneyCandidate[] {
  const priority = (candidate: JourneyCandidate): number => {
    const train = candidate.train;
    if (train?.line === expectedLine) return 0;
    if (train?.category?.toUpperCase() === 'AVG') return 1;
    if (train?.transportType === 'CITY_TRAIN' || /^S\d/i.test(train?.line ?? '')) return 2;
    return 3;
  };

  return candidates
    .map((candidate, index) => ({ candidate, index, priority: priority(candidate) }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map(({ candidate }) => candidate);
}

class BahnExpertError extends Error {}

interface RpcBatchEntry {
  readonly result?: { readonly data?: string };
  readonly error?: {
    readonly json?: { readonly message?: string; readonly code?: number };
    readonly message?: string;
  };
}

async function callRpc(procedure: string, input: unknown, timeoutMs: number): Promise<unknown> {
  const encoded = JSON.stringify({ '0': JSON.stringify(stringifyDevalue(input)) });
  const url = `${RPC_BASE}/${procedure}?batch=1&input=${encodeURIComponent(encoded)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new BahnExpertError(`${procedure} responded ${response.status}`);
    }
    const body = await response.text();
    if (body.length === 0) {
      // The empty-206 signature: almost always a rejected User-Agent rather than "no results".
      throw new BahnExpertError(`${procedure} returned an empty body (User-Agent rejected?)`);
    }
    const batch = JSON.parse(body) as ReadonlyArray<RpcBatchEntry>;
    const entry = batch[0];
    if (entry?.error) {
      const message = entry.error.json?.message ?? entry.error.message ?? 'unknown RPC error';
      throw new BahnExpertError(`${procedure} failed: ${message}`);
    }
    const data = entry?.result?.data;
    if (data === undefined) return null;
    return parseDevalue(JSON.parse(data) as unknown[]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Find journeys carrying `journeyNumber` on `departureDate`.
 *
 * A number is not unique across operators — KVV's Zugnummern collide with local bus lines — so
 * callers should prioritize plausible lines/categories, then validate the full journey details.
 */
export async function findJourneys(
  journeyNumber: number,
  departureDate: Date,
  timeoutMs: number,
): Promise<readonly JourneyCandidate[]> {
  const result = await callRpc(
    'journey.find',
    { journeyNumber, initialDepartureDate: departureDate, withOEV: true },
    timeoutMs,
  );
  if (!Array.isArray(result)) return [];
  return result.filter(
    (entry): entry is JourneyCandidate =>
      typeof (entry as JourneyCandidate)?.journeyId === 'string',
  );
}

/** Fetch the full stop list for a journey, including per-stop cancellation and realtime data. */
export async function fetchJourneyDetails(
  journeyId: string,
  timeoutMs: number,
): Promise<JourneyDetails | null> {
  const result = await callRpc('journey.detailsByJourneyId', journeyId, timeoutMs);
  if (result === null || typeof result !== 'object') return null;
  return result as JourneyDetails;
}
