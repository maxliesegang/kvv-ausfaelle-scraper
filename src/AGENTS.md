# Scraper Agents

Guidance in this file applies to `src/**` unless a deeper `AGENTS.md` overrides it.

## Pipeline Responsibilities

1. RSS parsing (`src/rss.ts`)
   - fetch KVV RSS (`RSS_URL`)
   - parse feed items
2. Relevance and workflow (`src/relevance.ts`, `src/workflow.ts`)
   - score/filter relevant items
   - fetch detail pages
3. Detail parsing (`src/parser/**`)
   - extract structured trip cancellations
   - handle known text/format variants
4. Storage and indices (`src/storage.ts`, `src/siteIndex.ts`)
   - write `docs/<fahrplan-year>/<line>.json`
   - regenerate root/year HTML+JSON indices

## Domain Rules

- Use Fahrplan years (`src/fahrplan.ts`) for storage/mapping, not calendar years.
- Keep parser behavior resilient:
  - transient article issues should not corrupt stored data
  - hard parser regressions should remain visible
- Relevance should avoid non-cancellation noise while preserving true cancellation notices.

## Runtime Configuration

- `RSS_URL` (default: `https://www.kvv.de/ticker_rss.xml`)
- `DATA_DIR` (default: `docs`)
- `FETCH_TIMEOUT_MS` (default: `15000`)

## Validation By Change Type

1. Any `src/**` change:
   - `npm run type-check`
   - `npm run format:check`
2. Parser/relevance/workflow changes (`src/parser/**`, `src/relevance.ts`, `src/workflow.ts`):
   - `npm run test:parser`
   - `npm run test:unit`
3. Train-line mapping changes (`src/train-line-definitions/**`, `src/train-lines.ts`, `src/fahrplan.ts`):
   - `npm run test:train-lines`
   - `npm run test:unit`
