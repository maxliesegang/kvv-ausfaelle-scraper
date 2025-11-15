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

1. Requirements: Node 20+
2. Install deps: `npm ci`
3. Build TypeScript: `npm run build`
4. Run the scraper: `npm start` (writes output into `docs/` and refreshes the HTML indexes)

## Useful scripts

- `npm run format` / `npm run format:check` — Prettier formatting
- `npm run test:parser` — Run parser tests on test articles
- `npm run train-lines:from-tests` — Extract train-number ↔ line mappings from parser fixtures
- `npm run fetch-article <url>` — Fetch a live article and save as test data

## Testing

The parser is tested against real KVV article HTML to ensure accurate extraction of cancellation data.

### Adding test articles

Fetch and save a live article as test data using the automated script:

```bash
npm run fetch-article "https://www.kvv.de/fahrplan/verkehrsmeldungen.html?tx_ixkvvticker_list%5Baction%5D=detail&tx_ixkvvticker_list%5Bcontroller%5D=Ticker&tx_ixkvvticker_list%5BdetailID%5D=Nettro_CMS_257073"
```

This will:

1. Fetch the HTML from the URL
2. Parse it to extract line numbers and trips
3. Save with the format: `article-<id>-<line>.html` (e.g., `article-257073-s1-s11.html`)
4. Generate expected output JSON for testing

Test files are saved to:

- `test-data/articles/` — HTML files
- `test-data/expected/` — Expected JSON outputs

### Running tests

```bash
npm run test:parser
```

This validates that the parser correctly extracts all trip information from each test article.

## Configuration

- `RSS_URL` — RSS source URL (default: `https://www.kvv.de/ticker_rss.xml`)
- `DATA_DIR` — Output directory that GitHub Pages serves (default: `docs`)
- `FETCH_TIMEOUT_MS` — HTTP timeout in milliseconds (default: `15000`)

## Automation

`.github/workflows/update-data.yml` runs every 6 hours (UTC) and on manual dispatch. The workflow installs dependencies, builds the scraper, runs it, formats the working tree via `npm run format`, and commits any changes under `docs/` so the published data and HTML indexes stay current.

## License

Released under the MIT License. See the `LICENSE` file for details.
