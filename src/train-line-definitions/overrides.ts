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
 * Overrides are **scoped to a single article** by its KVV `detailID` (e.g.
 * `Nettro_CMS_271521`). This is deliberate: a conflict is usually a one-off KVV typo in
 * that one notice, so forcing the number line-wide would misfile a *different* article
 * where the same number is correct in GTFS. An entry therefore only fires for the exact
 * article that needs it.
 *
 * Keep it empty when GTFS is complete. Keyed by Fahrplan year (train numbers are reassigned
 * between years), then by article id, then by train number → forced line.
 */
export const TRAIN_LINE_OVERRIDES: Readonly<
  Record<number, Readonly<Record<string, Readonly<Record<string, string>>>>>
> = {
  2026: {
    // S5/S51 AVG staffing cancellations, 2026-07-04. GTFS files these Söllingen–Wörth
    // Badepark runs under sibling short-workings (85758→S41, 85855→S42) or omits them
    // (85096), while every neighbouring Zugnummer in the same notice is S5. Scoped to this
    // article in case the numbers are genuinely S41/S42 in other runs.
    Nettro_CMS_271521: {
      '85758': 'S5',
      '85855': 'S5',
      '85096': 'S5',
    },
    // DB-Regio S6 runs in this staffing notice. GTFS reuses these numbers on unrelated
    // S4/S8/S41/S71/S81 services and has no matching S6 signature for the reported times.
    Nettro_CMS_272859: {
      '74351': 'S6',
      '74352': 'S6',
    },
    // AVG staffing notice for S1/S11 (Ettlingen Albgaubad–Hochstetten), 2026-07-27. The
    // KA Tullastraße–Ittersbach Rathaus run 40014 is an S12 in GTFS — S12 is the
    // reinforcement line on the S11 Ittersbach corridor, so KVV reports it under S11.
    Nettro_CMS_273364: {
      '40014': 'S11',
    },
    // Same S12-on-the-S11-corridor case as Nettro_CMS_273364, re-reported in the AVG
    // staffing notice for S1/S11 (Ettlingen Stadt–Hochstetten) of 2026-07-30.
    Nettro_CMS_273610: {
      '40014': 'S11',
    },
    // Same S12-on-the-S11-corridor case in the AVG staffing notice for S1/S11 of 2026-08-03.
    // The Ittersbach Rathaus–KA Tullastraße run 40015 is listed as S12 in GTFS, while KVV
    // reports it under the S11 corridor.
    Nettro_CMS_273841: {
      '40015': 'S11',
    },
    // AVG staffing notice for S5/S51 (Pforzheim Hbf–Wörth Badepark bzw. Germersheim),
    // 2026-07-29. GTFS knows the Germersheim–KA Marktplatz run 85481 only as an S52 — the
    // sibling short-working on the S51 Germersheim corridor, which the article never
    // mentions — while every neighbouring Germersheim run in the same notice (84892, 84896,
    // 84901, 84917) carries both S52 and S51 and resolves to S51.
    Nettro_CMS_273506: {
      '85481': 'S51',
    },
    // AVG staffing notice for S5/S51 (Söllingen–Germersheim), 2026-08-13. Same S52-on-the-
    // S51-Germersheim-corridor case as Nettro_CMS_273506: GTFS knows the Germersheim–KA
    // Marktplatz run 84885 only as an S52, while its outbound counterpart in the same
    // notice (84874, KA Albtalbahnhof–Germersheim) is an S51. GTFS has no 80702 at all;
    // it is the KA Marktplatz–Albtalbahnhof continuation of 84885 on the same corridor,
    // which the S5 (Söllingen–Wörth/Pforzheim) services never touch.
    Nettro_CMS_274370: {
      '84885': 'S51',
      '80702': 'S51',
    },
  },
};
