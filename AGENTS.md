# Agents & Automation

This document describes the automated agents and workflows that power the KVV cancellations scraper.

## Overview

The project uses automated agents to continuously monitor, scrape, and publish KVV transit cancellation data without manual intervention.

## GitHub Actions Automation Agent

### Purpose

The primary automation agent is a GitHub Actions workflow that runs the scraper on a fixed schedule and commits any new cancellation data to the repository.

### Schedule

- **Frequency**: Every 4 hours (6 times per day)
- **Times (UTC)**: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00
- **Trigger**: Can also be manually dispatched via GitHub UI

### Workflow Steps

The automation agent ([`.github/workflows/update-data.yml`](.github/workflows/update-data.yml)) performs the following operations:

1. **Environment Setup**
   - Checks out the repository
   - Sets up Node.js 20
   - Installs dependencies via `npm ci`

2. **Build & Execute**
   - Compiles TypeScript: `npm run build`
   - Runs the scraper: `npm start`
   - Formats output: `npm run format`

3. **Data Publication**
   - Stages changes in `docs/` directory
   - Commits with message: "Update KVV cancellations (docs)"
   - Pushes to main branch (only if changes detected)
   - GitHub Pages automatically deploys the updated data

### Agent Capabilities

The scraper agent performs these tasks autonomously:

- **RSS Feed Monitoring**: Fetches KVV's RSS ticker for new cancellation announcements
- **HTML Parsing**: Follows detail page links and extracts structured trip cancellation data
- **Data Deduplication**: Prevents duplicate entries within each run
- **File Organization**: Writes JSON files organized by year and line number
- **Index Generation**: Regenerates HTML and JSON indices for web navigation
- **Train Line Recognition**: Maps train numbers to line designations using predefined rules

## Data Processing Pipeline

### Input Sources

- KVV RSS feed (default: `https://www.kvv.de/ticker_rss.xml`)
- Individual article detail pages linked from RSS items

### Processing Stages

1. **RSS Parsing** ([`src/rss.ts`](src/rss.ts))
   - Fetches RSS feed
   - Filters for cancellation-related items
   - Extracts detail page URLs

2. **Article Parsing** ([`src/workflow.ts`](src/workflow.ts))
   - Downloads HTML from detail pages
   - Extracts trip cancellations (date, times, stops, train numbers)
   - Identifies affected train lines

3. **Storage & Indexing** ([`src/storage.ts`](src/storage.ts), [`src/siteIndex.ts`](src/siteIndex.ts))
   - Saves to `docs/<year>/<line>.json`
   - Updates year and root indices
   - Generates browsable HTML pages

### Output Format

All data is published to the `docs/` directory and served via GitHub Pages:

- Root index: [`docs/index.html`](https://maxliesegang.github.io/kvv-ausfaelle-scraper/) and [`docs/index.json`](https://maxliesegang.github.io/kvv-ausfaelle-scraper/index.json)
- Year indices: `docs/<year>/index.html` and `docs/<year>/index.json`
- Line data: `docs/<year>/<line>.json`

## Configuration

The automation agent respects these environment variables:

- `RSS_URL`: RSS feed source (default: KVV ticker)
- `DATA_DIR`: Output directory (default: `docs`)
- `FETCH_TIMEOUT_MS`: HTTP request timeout (default: `15000`)

## Manual Operation

While the agent runs automatically, you can also trigger operations manually:

```bash
# Run the scraper locally
npm run dev

# Or step-by-step
npm run build
npm start
```

## Future Agent Possibilities

Potential enhancements for the automation system:

- **Alert Agent**: Monitor for specific lines or routes and send notifications
- **Analytics Agent**: Generate statistics on cancellation patterns and trends
- **Validation Agent**: Verify data quality and flag anomalies
- **Archive Agent**: Compress and archive historical data beyond a retention period
- **API Agent**: Expose real-time query endpoints for the collected data
- **Multi-Source Agent**: Aggregate data from additional transit sources

## Monitoring & Logs

- **GitHub Actions**: View execution logs at [Actions tab](../../actions)
- **Commit History**: Track data updates in commit messages
- **Pages Deployment**: Monitor at [Deployments tab](../../deployments)

## Failure Handling

The automation agent is designed to be resilient:

- **Network Failures**: Timeout protection via `FETCH_TIMEOUT_MS`
- **Parse Failures**: Individual article failures don't halt the entire run
- **No Changes**: Skip commit/push if no new data detected
- **Build Failures**: Workflow fails visibly in Actions tab for investigation

## Permissions

The GitHub Actions bot requires:

- `contents: write` — To commit and push changes
- Default `GITHUB_TOKEN` — Automatically provided by GitHub Actions

## Contributing

When modifying the automation:

1. Test changes locally with `npm run dev`
2. Run parser tests: `npm run test:parser`
3. Verify type safety: `npm run type-check`
4. Ensure formatting: `npm run format:check`
5. Test workflow with manual dispatch before merging

## References

- Main scraper logic: [`src/index.ts`](src/index.ts)
- Workflow definition: [`.github/workflows/update-data.yml`](.github/workflows/update-data.yml)
- Train line mappings: [`docs/train-line-definitions/`](docs/train-line-definitions/)
