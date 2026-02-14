# KVV Ausfälle Scraper

Live data index: https://maxliesegang.github.io/kvv-ausfaelle-scraper/

TypeScript/Node script that fetches the public KVV RSS feed, parses the “Betriebsbedingte Fahrtausfälle” detail pages, and publishes structured cancellation data for GitHub Pages to host.

## What it does

- Downloads the RSS ticker (`RSS_URL`, defaults to `https://www.kvv.de/ticker_rss.xml`) and keeps only cancellation items.
- Follows every relevant detail page, extracts individual trip cancellations, and deduplicates per run.
- Writes JSON snapshots into `docs/<year>/<line>.json` and regenerates simple HTML indexes so the data can be browsed online.

## Live data & format

- GitHub Pages serves the contents of `docs/`. The root `index.html` lists available years; each year directory has its own index and JSON files grouped by line.
- **Navigation**: Both HTML and JSON indices are automatically generated:
  - `docs/index.html` and `docs/index.json` — Root index listing all years
  - `docs/<year>/index.html` and `docs/<year>/index.json` — Year-specific index listing all data files
- **Index JSON format**:
  - Root index: `{ "years": ["2025", ...], "generatedAt": "..." }`
  - Year index: `{ "year": "2025", "files": ["S1.json", "S11.json", ...], "generatedAt": "..." }`
- Sample data entry (see `docs/2025/S5.json`):

```json
{
  "line": "S5",
  "date": "2025-11-11",
  "stand": "2025-11-11T09:00:00.000Z",
  "trainNumber": "84763",
  "fromStop": "Rheinbergstraße",
  "fromTime": "15:51",
  "toStop": "Söllingen",
  "toTime": "16:37",
  "sourceUrl": "https://www.kvv.de/…detailID=Nettro_CMS_256858",
  "capturedAt": "2025-11-11T17:33:38.985Z"
}
```

## Running locally

1. Requirements: Node 22+
2. Install deps: `npm ci`
3. Build TypeScript: `npm run build`
4. Run the scraper: `npm start` (writes output into `docs/` and refreshes the HTML indexes)

## Useful scripts

**Development:**

- `npm run dev` — Build and run the scraper in one command
- `npm run build:clean` — Clean dist folder and rebuild from scratch
- `npm run format` / `npm run format:check` — Prettier formatting
- `npm run type-check` — TypeScript type checking without emitting files
- `npm run lint` — Run type-check and format:check together

**Testing:**

- `npm test` — Run all tests
- `npm run test:unit` — Run only unit tests (fast)
- `npm run test:watch` — Watch mode - auto-rerun tests on changes
- `npm run test:coverage` — Run tests with coverage report
- `npm run test:parser` — Run just parser tests
- `npm run test:train-lines` — Run just train lines tests
- `npm run test:fallback <number>` — Manual test for fallback matching

**Data Management:**

- `npm run train-lines:from-tests` — Extract train-number ↔ line mappings from parser fixtures
- `npm run fetch-article <url>` — Fetch a live article and save as test data

## Testing

The project uses Node.js built-in test runner with comprehensive test coverage for parser and train line logic.

### Quick Start

```bash
# Run all tests
npm test

# Watch mode (best for development)
npm run test:watch

# Unit tests only (fast)
npm run test:unit

# With coverage report
npm run test:coverage
```

### Test Organization

```
tests/
├── unit/           # Fast, isolated tests (33 tests)
│   ├── parser.test.ts        # Parser logic (22 tests)
│   └── train-lines.test.ts   # Train line lookups (10 tests)
├── integration/    # Full workflow tests
│   └── fallback-matching.ts  # Fallback matching verification
└── helpers/        # Shared test utilities
```

**Current test coverage:**

- ✅ 33 passing tests
- ✅ Parser: 92% coverage (all real-world formats)
- ✅ Train lines: 70% coverage (exact match & fallback)
- ✅ Execution time: ~250ms

### Adding Test Articles

Fetch and save a live article as test data:

```bash
npm run fetch-article "https://www.kvv.de/fahrplan/verkehrsmeldungen.html?..."
```

This will:

1. Fetch the HTML from the URL
2. Parse it to extract line numbers and trips
3. Save to `test-data/articles/article-<id>-<line>.html`
4. Generate expected output in `test-data/expected/`

New test files are automatically discovered and run with `npm test`.

For detailed testing guide, see **[tests/README.md](tests/README.md)**.

## Configuration

- `RSS_URL` — RSS source URL (default: `https://www.kvv.de/ticker_rss.xml`)
- `DATA_DIR` — Output directory that GitHub Pages serves (default: `docs`)
- `FETCH_TIMEOUT_MS` — HTTP timeout in milliseconds (default: `15000`)

## Automation

`.github/workflows/update-data.yml` runs every 4 hours (UTC) and on manual dispatch. The workflow installs dependencies, builds the scraper, runs it, formats the working tree via `npm run format`, and commits any changes under `docs/` so the published data and HTML indexes stay current.

For detailed documentation about the automation agents and workflow, see [AGENTS.md](AGENTS.md).

## License

Released under the MIT License. See the `LICENSE` file for details.
