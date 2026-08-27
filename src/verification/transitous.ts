/**
 * Conservative Transitous/MOTIS client.
 *
 * Transitous normalizes KVV's static GTFS and SIRI realtime data. Its trip response exposes
 * explicit trip/stop cancellation flags and scheduled/current timestamps, but no per-stop
 * "vehicle observed" flag. We therefore preserve timestamps and let `verify.ts` apply its
 * existing varying-delay safeguard; an unchanged scheduled time is never promoted to tracking.
 */

import type { Cancellation } from '../types.js';
import { getBerlinWallClockMs } from '../utils/berlin-time.js';
import { normalizeGermanText } from '../utils/normalization.js';
import type { JourneyDetails, JourneyStop, JourneyStopEvent } from './bahn-expert.js';

const API_BASE = 'https://api.transitous.org/api';
const USER_AGENT = 'kvv-ausfaelle-scraper/1.0 (+trip verification)';
const CANDIDATE_WINDOW_SECONDS = 30 * 60;
const SEARCH_RADIUS_METRES = 750;
const MAX_GEOCODE_MATCHES = 2;
const MAX_TRIP_CANDIDATES = 5;

export interface TransitousPlace {
  readonly name: string;
  readonly id?: string;
  readonly stopId?: string;
  readonly lat?: number;
  readonly lon?: number;
  readonly arrival?: string;
  readonly departure?: string;
  readonly scheduledArrival?: string;
  readonly scheduledDeparture?: string;
  readonly cancelled?: boolean;
}

export interface TransitousStopTime {
  readonly place: TransitousPlace;
  readonly tripId: string;
  readonly tripShortName?: string;
  readonly displayName?: string;
  readonly routeShortName?: string;
  readonly agencyId?: string;
  readonly agencyName?: string;
  readonly realTime?: boolean;
  readonly cancelled?: boolean;
  readonly tripCancelled?: boolean;
}

export interface TransitousLeg {
  readonly tripId?: string;
  readonly tripShortName?: string;
  readonly displayName?: string;
  readonly routeShortName?: string;
  readonly agencyId?: string;
  readonly agencyName?: string;
  readonly cancelled?: boolean;
  readonly realTime?: boolean;
  readonly from: TransitousPlace;
  readonly to: TransitousPlace;
  readonly intermediateStops?: readonly TransitousPlace[];
}

export interface TransitousItinerary {
  readonly id?: string;
  readonly legs?: readonly TransitousLeg[];
}

interface GeocodeMatch extends TransitousPlace {
  readonly type?: string;
}

interface StopTimesResponse {
  readonly stopTimes?: readonly TransitousStopTime[];
}

export class TransitousError extends Error {}

async function fetchJson<T>(url: URL, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new TransitousError(
        `${url.pathname} responded ${response.status} ${response.statusText}`,
      );
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof TransitousError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new TransitousError(`${url.pathname} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const geocodeCache = new Map<string, Promise<readonly GeocodeMatch[]>>();

async function geocodeStop(name: string, timeoutMs: number): Promise<readonly GeocodeMatch[]> {
  const key = normalizeGermanText(name);
  const cached = geocodeCache.get(key);
  if (cached) return cached;

  const request = (async () => {
    const url = new URL(`${API_BASE}/v1/geocode`);
    url.searchParams.set('text', name);
    url.searchParams.set('type', 'STOP');
    url.searchParams.set('numResults', String(MAX_GEOCODE_MATCHES));
    return fetchJson<readonly GeocodeMatch[]>(url, timeoutMs);
  })();
  geocodeCache.set(key, request);
  try {
    return await request;
  } catch (error) {
    geocodeCache.delete(key);
    throw error;
  }
}

function isNetworkOperator(name: string | undefined): boolean {
  return name === undefined || normalizeGermanText(name).includes('albtal');
}

function scheduledDepartureMs(stopTime: TransitousStopTime): number {
  const value = stopTime.place.scheduledDeparture ?? stopTime.place.departure;
  return value ? Date.parse(value) : Number.NaN;
}

/** Filter a noisy radius stop-board response down to the exact AVG Zugnummer/date. */
export function selectTransitousCandidates(
  cancellation: Cancellation,
  stopTimes: readonly TransitousStopTime[],
): TransitousStopTime[] {
  const numericTrainNumber = Number(cancellation.trainNumber);
  if (!Number.isFinite(numericTrainNumber)) return [];

  const wantedNumber = String(numericTrainNumber);
  const wantedMs = getBerlinWallClockMs(cancellation.date, cancellation.fromTime);
  const maximumDeltaMs = CANDIDATE_WINDOW_SECONDS * 1000;
  const seen = new Set<string>();

  return stopTimes
    .filter((candidate) => {
      if (String(Number(candidate.tripShortName)) !== wantedNumber) return false;
      if (!isNetworkOperator(candidate.agencyName)) return false;
      const departureMs = scheduledDepartureMs(candidate);
      if (Number.isNaN(departureMs) || Math.abs(departureMs - wantedMs) > maximumDeltaMs) {
        return false;
      }
      if (seen.has(candidate.tripId)) return false;
      seen.add(candidate.tripId);
      return true;
    })
    .sort((a, b) => {
      const aLine = a.routeShortName ?? a.displayName;
      const bLine = b.routeShortName ?? b.displayName;
      return Number(bLine === cancellation.line) - Number(aLine === cancellation.line);
    })
    .slice(0, MAX_TRIP_CANDIDATES);
}

export async function findTransitousTrips(
  cancellation: Cancellation,
  departureInstant: Date,
  timeoutMs: number,
): Promise<TransitousStopTime[]> {
  const matches = await geocodeStop(cancellation.fromStop, timeoutMs);
  for (const match of matches) {
    if (!Number.isFinite(match.lat) || !Number.isFinite(match.lon)) continue;
    const url = new URL(`${API_BASE}/v6/stoptimes`);
    url.searchParams.set('center', `${match.lat},${match.lon}`);
    url.searchParams.set('radius', String(SEARCH_RADIUS_METRES));
    url.searchParams.set('exactRadius', 'true');
    url.searchParams.set('time', departureInstant.toISOString());
    url.searchParams.set('window', String(CANDIDATE_WINDOW_SECONDS));
    url.searchParams.set('realtimeMode', 'REALTIME_ANNOTATION_ONLY');
    url.searchParams.set('withScheduledSkippedStops', 'true');
    url.searchParams.set('withAlerts', 'false');
    const response = await fetchJson<StopTimesResponse>(url, timeoutMs);
    const candidates = selectTransitousCandidates(cancellation, response.stopTimes ?? []);
    if (candidates.length > 0) return candidates;
  }
  return [];
}

export async function fetchTransitousTrip(
  tripId: string,
  timeoutMs: number,
): Promise<TransitousItinerary> {
  const url = new URL(`${API_BASE}/v6/trip`);
  url.searchParams.set('tripId', tripId);
  url.searchParams.set('withScheduledSkippedStops', 'true');
  url.searchParams.set('detailedLegs', 'false');
  url.searchParams.set('joinInterlinedLegs', 'false');
  return fetchJson<TransitousItinerary>(url, timeoutMs);
}

function delayMinutes(actual: string | undefined, scheduled: string | undefined): number | null {
  if (!actual || !scheduled) return null;
  const actualMs = Date.parse(actual);
  const scheduledMs = Date.parse(scheduled);
  if (Number.isNaN(actualMs) || Number.isNaN(scheduledMs)) return null;
  return Math.round((actualMs - scheduledMs) / (60 * 1000));
}

function toEvent(
  actual: string | undefined,
  scheduled: string | undefined,
  cancelled: boolean | undefined,
  leg: TransitousLeg,
): JourneyStopEvent | null {
  if (!actual && !scheduled) return null;
  const time = actual ?? scheduled;
  return {
    ...(scheduled ? { scheduledTime: scheduled } : {}),
    ...(time ? { time } : {}),
    delay: delayMinutes(actual, scheduled),
    // MOTIS only exposes a leg-wide realtime bit. Treating it as a per-stop observation would
    // turn one forecast into a fully tracked run, so timestamps pass through the existing
    // varying-delay safeguard instead.
    isRealTime: null,
    cancelled: cancelled ?? null,
    transport: {
      administration: {
        ...(leg.agencyId ? { administrationID: leg.agencyId } : {}),
        ...(leg.agencyName ? { operatorName: leg.agencyName } : {}),
      },
    },
  };
}

function toJourneyStop(place: TransitousPlace, leg: TransitousLeg): JourneyStop {
  return {
    stopPlace: { name: place.name },
    arrival: toEvent(place.arrival, place.scheduledArrival, place.cancelled, leg),
    departure: toEvent(place.departure, place.scheduledDeparture, place.cancelled, leg),
    cancelled: place.cancelled ?? null,
  };
}

/** Convert one normalized MOTIS trip into the classifier's source-neutral journey shape. */
export function mapTransitousJourney(
  itinerary: TransitousItinerary,
  candidate: TransitousStopTime,
): JourneyDetails | null {
  const leg = itinerary.legs?.find(
    (value) => value.tripId === candidate.tripId || value.tripShortName === candidate.tripShortName,
  );
  if (!leg) return null;

  const places = [leg.from, ...(leg.intermediateStops ?? []), leg.to];
  const stops = places.map((place) => toJourneyStop(place, leg));
  const journeyCancelled = leg.cancelled === true || candidate.tripCancelled === true;

  // A stop-board update can retain an explicit origin cancellation after the detailed trip has
  // already thinned it out. Keep that source statement on the matching departure event.
  if (candidate.cancelled === true) {
    const candidateTime = candidate.place.scheduledDeparture;
    const index = places.findIndex(
      (place) =>
        place.scheduledDeparture === candidateTime &&
        normalizeGermanText(place.name) === normalizeGermanText(candidate.place.name),
    );
    const stop = index >= 0 ? stops[index] : undefined;
    if (stop) {
      stops[index] = {
        ...stop,
        departure: { ...(stop.departure ?? {}), cancelled: true },
      };
    }
  }

  return {
    journeyId: candidate.tripId,
    cancelled: journeyCancelled,
    stops,
    train: {
      ...((leg.routeShortName ?? leg.displayName)
        ? { line: leg.routeShortName ?? leg.displayName }
        : {}),
      journeyNumber: Number(leg.tripShortName ?? candidate.tripShortName),
      ...(leg.agencyId ? { admin: leg.agencyId } : {}),
      ...(leg.agencyName ? { operator: leg.agencyName } : {}),
    },
  };
}
