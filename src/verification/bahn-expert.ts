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
 * The API only answers for roughly the **last six days**; older dates fail outright. Realtime and
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

/** How far back the gateway answers. Measured, not documented: -6 days works, -7 returns 400. */
export const MAX_LOOKBACK_DAYS = 6;

export interface JourneyStopEvent {
  readonly scheduledTime?: string;
  readonly time?: string;
  readonly delay?: number | null;
  readonly cancelled?: boolean | null;
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
  readonly train?: { readonly line?: string; readonly journeyNumber?: number };
}

export interface JourneyCandidate {
  readonly journeyId: string;
  readonly train?: { readonly line?: string };
}

class BahnExpertError extends Error {}

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
    const batch = JSON.parse(body) as ReadonlyArray<{ result?: { data?: string } }>;
    const data = batch[0]?.result?.data;
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
 * callers must narrow the result by `train.line` before fetching details.
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
