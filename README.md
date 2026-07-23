# KVV Ausfälle Scraper

Live data index: https://maxliesegang.github.io/kvv-ausfaelle-scraper/

A TypeScript/Node.js scraper that reads public KVV cancellation notices, extracts affected
trips, classifies their reported cause, and publishes versioned JSON data through GitHub Pages.

## What it does

- Reads the KVV RSS ticker and selects cancellation notices.
- Fetches each relevant detail page and parses the supported human-written trip layouts.
- Resolves train numbers to lines using Fahrplan-year GTFS definitions, timing signatures, and
  narrowly scoped overrides for known source conflicts.
- Applies one article-level `cause` and its matching `causeKeyword` evidence to every parsed trip.
- Reconciles successfully refetched articles with stored data so updated classifications replace
  old ones and trips removed from an article do not survive as stale records.
- Archives stable, readable article text under `docs/<fahrplan-year>/articles/` for traceability
  and offline parser regression checks.
- Regenerates the JSON and HTML indices served by GitHub Pages.

## Published data

Cancellation data is organized by **Fahrplan year**, not calendar year. For example, a trip on
2024-12-16 belongs to the 2025 Fahrplan year.

```text
docs/
├── index.html
├── index.json
└── <fahrplan-year>/
    ├── index.html
    ├── index.json
    ├── <line>.json
    ├── articles/<detailID>.txt
    └── train-line-definitions/
        ├── <line>.json
        └── ambiguous-trips.json
```

- Root index JSON:
  `{ "schemaVersion": 1, "years": ["2025", ...], "causes": [...], "generatedAt": "..." }`
- Fahrplan-year index JSON:
  `{ "year": "2025", "files": ["S1.json", ...], "generatedAt": "..." }`

The ordered root `causes` array is the public cause taxonomy for consumers. Each entry has a
stable `id`, German `label`, and German `description`; its array position is the recommended
display order. `schemaVersion` changes only when the root contract changes incompatibly.

Each line file contains cancellation records:

```json
{
  "line": "S5",
  "date": "2025-11-11",
  "stand": "2025-11-11T08:00:00.000Z",
  "trainNumber": "84763",
  "fromStop": "Rheinbergstraße",
  "fromTime": "15:51",
  "toStop": "Söllingen",
  "toTime": "16:37",
  "sourceUrl": "https://www.kvv.de/…detailID=Nettro_CMS_256858",
  "capturedAt": "2025-11-11T17:33:38.985Z",
  "cause": "operational",
  "causeKeyword": "betriebsbedingt"
}
```

`cause` is a best-effort article-level category:

`strike`, `weather`, `emergency`, `vehicle`, `infrastructure`, `technical`, `personnel`,
`operational`, `disruption`, `construction`, or `unknown`.

`causeKeyword` is the normalized keyword that selected the category. It is `null` when no evidence
is available, including `unknown` classifications and legacy records that predate evidence
storage. The field preserves classifier evidence without requiring consumers to re-read the
archived article.

## Running locally

Requirements: Node.js 22 or newer.

```bash
npm ci
npm run dev
```

`npm run dev` builds and runs the scraper. By default it updates `docs/`; set `DATA_DIR` to use
another output directory.

To build and run separately:

```bash
npm run build
npm start
```

## Commands

### Development and validation

- `npm run dev` — build and run the scraper
- `npm run build` — compile TypeScript
- `npm run build:clean` — remove `dist/` and rebuild
- `npm run type-check` — type-check without emitting files
- `npm run format` / `npm run format:check` — write or verify Prettier formatting
- `npm run lint` — run type-check and formatting checks

### Tests

- `npm test` — run every test
- `npm run test:unit` — run the unit suite
- `npm run test:integration` — run integration tests
- `npm run test:parser` — run parser regression tests
- `npm run test:train-lines` — run train-line resolution tests
- `npm run test:watch` — rerun tests on changes
- `npm run test:coverage` — generate a coverage report

The unit suite includes real article fixtures, archive/reparse fidelity, the preserved-article
corpus audit, cause classification, storage reconciliation, Fahrplan-year train-line resolution,
GTFS seeding, relevance, normalization, and site-index generation.

See [tests/README.md](tests/README.md) for test organization and
[test-data/README.md](test-data/README.md) for fixture conventions.

### Data maintenance

- `npm run fetch-article -- <url>` — fetch a live detail page and create matching parser fixtures
- `npm run seed-train-lines -- <gtfs.zip> [--year=N]` — regenerate a Fahrplan year's line
  definitions and ambiguous-trip timing sidecar; see [gtfs-data/README.md](gtfs-data/README.md)
- `npm run reparse-archives -- [--year=N] [--verbose]` — read-only comparison of archived
  articles against stored trips
- `npm run reparse-archives -- --write [--year=N]` — backfill only `cause` and `causeKeyword`
  for stored trips that reparse to the same identity
- `npm run reparse-archives -- --write-trips [--year=N]` — fully reconcile successfully parsed
  archived articles with stored trips

`--write` and `--write-trips` are mutually exclusive. Parse failures never authorize deletion:
only successfully parsed archives participate in reconciliation.

## Configuration

- `RSS_URL` — RSS source URL; default `https://www.kvv.de/ticker_rss.xml`
- `DATA_DIR` — data and publication root; default `docs`
- `FETCH_TIMEOUT_MS` — HTTP timeout in milliseconds; default `15000`

## Automation

`.github/workflows/update-data.yml` runs every four hours and on manual dispatch. It builds and
runs the scraper, formats generated files, commits changes under `docs/`, and deploys that same
directory to GitHub Pages. The scraper step may fail visibly after safe data has been committed
and deployed, keeping parser regressions observable without discarding valid results.

## Repository guidance

Path-scoped `AGENTS.md` files document the invariants and validation commands for source,
parser, train-line definitions, scripts, tests, fixtures, workflows, and generated artifacts.
Start with [AGENTS.md](AGENTS.md).

## License

Released under the MIT License. See [LICENSE](LICENSE).
