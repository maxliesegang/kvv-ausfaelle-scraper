# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

TypeScript/Node script that fetches the public KVV (Karlsruhe transit) RSS feed, parses the "Betriebsbedingte Fahrtausfälle" detail pages, extracts structured trip-cancellation data, and publishes JSON + HTML indices under `docs/` for GitHub Pages. ESM (`"type": "module"`), Node 22+, no runtime bundler (tsx for dev, tsc for build). Only runtime dependency is `rss-parser`.

## Commands

- Build / run: `npm run build`, `npm start`, or `npm run dev` (build + run)
- Lint: `npm run lint` (runs `type-check` + `format:check`); fix formatting with `npm run format`
- All tests: `npm test` — unit only (fast): `npm run test:unit`
- Single test file: `npm run test:parser`, `npm run test:train-lines`, or `node --import tsx --test tests/unit/<file>.test.ts`
- Watch mode: `npm run test:watch`; coverage: `npm run test:coverage`
- Fetch a live article as a test fixture: `npm run fetch-article "<url>"` (writes to `test-data/articles/` + `test-data/expected/`)

## Architecture

The pipeline runs end-to-end from `src/index.ts` → `src/workflow.ts`:

1. **Fetch + filter RSS** (`src/rss.ts`, `src/relevance.ts`) — download the feed, score each item with multi-criteria relevance scoring, keep only cancellation notices.
2. **Fetch detail pages** (`src/workflow.ts`) — for each relevant item, fetch the HTML, re-check relevance, and skip articles younger than 1 hour (`MIN_ARTICLE_AGE_MS`). Uses `Promise.allSettled` so one bad article never aborts the run.
3. **Parse trips** (`src/parser/**`) — extract individual structured trip cancellations from the HTML, and classify the article-level cause (`src/cause.ts`) which is stamped onto every trip.
4. **Store + index** (`src/storage.ts`, `src/site-index.ts`) — bucket by line, deduplicate, **reconcile** (drop stored trips whose re-fetched source article no longer lists them — KVV edits detail pages in place, sometimes without bumping `Stand`, so trips can silently vanish), write `docs/<year>/<line>.json`, and regenerate root/year HTML + JSON index pages. Reconciliation only prunes entries whose `sourceUrl` was successfully re-fetched this run, so a transient fetch failure never deletes stored data.

Relevance keeps all true cancellation notices and never vetoes by cause — construction-only notices are retained, not dropped. Instead, each cancellation carries a best-effort `cause` field (`CancellationCause`: `operational | strike | technical | weather | construction | unknown`) computed by `classifyCause` (`src/cause.ts`), an ordered first-match keyword classifier. `operational` is the catch-all for these notices: it covers both the generic `betriebsbedingt` (KVV's umbrella term) and explicit staff/sickness wording (`personalmangel`, `krankheit…`).

Train-number → line mapping (`src/train-lines.ts`, `src/train-line-definitions/`) is a flat per-line list of train numbers (`trainNumbers`), seeded in full from GTFS with a number kept on **every** line GTFS runs it on. There is no runtime learning. Single-line and line-prefixed articles use the article's own line directly. For a multi-line article the train number is resolved against the mapping, and because GTFS reuses one Zugnummer across connected lines (~10% of numbers run on more than one line), a sidecar disambiguates by timing: `docs/<year>/train-line-definitions/ambiguous-trips.json` records each shared number's per-trip `{ line, dep, arr, dates }` signatures, and `resolveAmbiguousTrip` (`src/train-line-definitions/ambiguous-trips.ts`) matches the article's date and the trip's departure/arrival times (tolerant of a minute of rounding, midnight-aware) to report **exactly the line(s) of the one physical run** — one line for a recycled number (separate trains sharing a Zugnummer), several for a through-running train that changes line mid-run. When timing cannot anchor a run it falls back to every mentioned line the number runs on. A number that maps to none of the mentioned lines throws `MultiLineMappingError` (a hard parse error); `src/train-line-definitions/overrides.ts` is a small lookup-time escape hatch for that case (normally empty). Re-seed a Fahrplan year offline with `npm run seed-train-lines -- <gtfs.zip> --year=<n>` (`scripts/seed-train-lines-from-gtfs.ts` reads a GTFS zip directly and overwrites that year's per-line lists plus the `ambiguous-trips.json` sidecar with pure GTFS data).

### Key invariants

- **Fahrplan year, not calendar year.** All storage and train-line definitions are organized by Fahrplan (timetable) year, defined in `src/fahrplan.ts`. Never substitute calendar year.
- **Error visibility is deliberate.** Transient/article-specific issues are logged and skipped so stored data stays intact, but genuine parser regressions (`ParseError` with trip-like times present but no parsed trips) are re-thrown. `index.ts` saves valid data first, then `process.exit(1)` if any `parseError` occurred **or** any saved cancellation has an `unknown` cause — so CI fails loudly (as a notification to extend `classifyCause`) while still publishing the good data it just committed.
- `docs/` is the published artifact served by GitHub Pages; the scraper writes directly into it as the single source of truth.

### Config (env vars, see `src/config.ts`)

`RSS_URL` (default `https://www.kvv.de/ticker_rss.xml`), `DATA_DIR` (default `docs`), `FETCH_TIMEOUT_MS` (default `15000`).

## Conventions

- All built-in imports use the `node:` prefix; relative imports use `.js` extensions (ESM).
- Shared helpers live in `src/utils/` (`fs.ts`, `constants.ts`, `normalization.ts`) — prefer them over ad-hoc reimplementation. German-text keyword matching (relevance + cause) must go through `normalizeGermanText`, which expands umlauts (ä→ae, ö→oe, ü→ue, ß→ss) before stripping diacritics so source spellings like `entfällt` match `ae/oe/ue` keyword forms.

## Path-scoped guidance

This repo uses nested `AGENTS.md` files for area-specific rules — **read the closest one to the files you are editing**: `src/AGENTS.md`, `src/parser/AGENTS.md`, `src/train-line-definitions/AGENTS.md`, `tests/AGENTS.md`, `test-data/AGENTS.md`, `scripts/AGENTS.md`, `docs/AGENTS.md`, `.github/workflows/AGENTS.md`. Notably: parser/relevance changes should add or adjust unit tests, and keep `tests/unit/**` deterministic and fast.

## Automation

`.github/workflows/update-data.yml` runs every 4 hours (and on manual dispatch): installs deps, builds, runs the scraper, formats the tree, and commits any changes under `docs/`.
