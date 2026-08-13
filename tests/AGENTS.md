# Test Agents

Guidance in this file applies to `tests/**`.
This is the most specific guidance for test code.

## Test Layout

- Unit tests: `tests/unit/**`
- Integration tests: `tests/integration/**`
- Shared helpers: `tests/helpers/**`

## Expectations

- Parser and relevance logic changes should add/adjust unit tests.
- Cause classification (`src/cause.ts`) and `normalizeGermanText` umlaut handling have dedicated unit tests; update them when extending keyword lists or normalization.
- Construction-only notices are now expected to be relevant (kept, tagged `cause: 'construction'`), not filtered out.
- Keep tests deterministic and fast in `tests/unit/**`.
- `tests/unit/archive-corpus.test.ts` audits every preserved archive for GTFS-known and explicit
  train-number rows. Parser changes must keep this corpus audit green, not only fixture tests.
  It skips diversion statements via the parser's own `isDiversionRow` — a rerouted train produces
  no trip. Keep using the shared predicate: a second copy here would drift from the scraper.
  Because it reads `docs/`, newly archived articles can turn it red with no code change, which is
  why `.github/workflows/update-data.yml` runs the suite after each scrape as well as `ci.yml`.
- `tests/unit/archive-relevance.test.ts` audits the same corpus for relevance recall: archives are
  written before either gate runs, so any archive that parses into trips must pass both
  `analyzeRssItem` (scored on a headline + lead-sentence reconstruction of the ticker item) and
  `analyzeDetailPage`. A gate rejecting one is silent data loss. Keyword or threshold changes in
  `src/relevance.ts` must keep it green, including its trip-less-notice precision guard.
- `tests/unit/article-archive.test.ts` verifies byte-stable archives and HTML/archive reparse
  fidelity.
- `tests/unit/storage.test.ts` pins the forward-looking reconciliation rule: a future trip KVV
  un-lists is pruned, a departed one is kept. Pass an explicit `nowMs` to `saveCancellations` so
  the fixtures' departures are judged against a fixed clock instead of the wall clock, which
  would flip these assertions as the fixture dates age.
- Integration tests may be slower or interact with real files; document side effects clearly.

## Useful Commands

- `npm test`
- `npm run test:unit`
- `npm run test:parser`
- `npm run test:train-lines`
- `npm run test:integration`
