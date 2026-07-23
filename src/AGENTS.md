# Scraper Agents

Guidance in this file applies to `src/**` unless a deeper `AGENTS.md` overrides it.

## Pipeline Responsibilities

1. RSS parsing (`src/rss.ts`)
   - fetch KVV RSS (`RSS_URL`)
   - parse feed items
2. Relevance and workflow (`src/relevance.ts`, `src/workflow.ts`)
   - score/filter relevant items (relevance no longer vetoes by cause; construction-only notices are kept)
   - fetch detail pages
3. Detail parsing (`src/parser/**`)
   - extract structured trip cancellations
   - handle known text/format variants
   - classify the article-level cause (`src/cause.ts`) and stamp it on every cancellation
4. Storage and indices (`src/storage.ts`, `src/site-index.ts`)
   - write `docs/<fahrplan-year>/<line>.json`
   - regenerate root/year HTML+JSON indices

## Domain Rules

- Use Fahrplan years (`src/fahrplan.ts`) for storage/mapping, not calendar years.
- Keep parser behavior resilient:
  - transient article issues should not corrupt stored data
  - hard parser regressions should remain visible
- Relevance should avoid non-cancellation noise while preserving true cancellation notices. It does not filter by cause — every true cancellation is kept and tagged with a `cause` (`CancellationCause`, see `src/types.ts` / `src/cause.ts`).
- Cause classification (`classifyCauseWithEvidence` in `src/cause.ts`, with `classifyCause` a
  thin category accessor) is an ordered first-match scan over
  `CANCELLATION_CAUSE_DEFINITIONS`. Those definitions are the single source for classification
  priority and the public root-index taxonomy; never maintain a second category list. The
  classifier returns the category plus the most-specific (longest) matching `causeKeyword`
  within that category. Priority is: strike → weather → emergency → vehicle → infrastructure
  → technical → personnel → operational → disruption → construction → unknown.
  - **`betriebsbedingt` is a euphemism, not a personnel signal.** `personnel` requires named
    staffing/sickness evidence (`personalmangel`, `krankheit…`, `fahrpersonal`); the bare phrase
    remains `operational`.
  - The technical family identifies what broke: `vehicle` for rolling stock,
    `infrastructure` for track/signals/power, and `technical` for a generic named fault.
  - `emergency` is a named emergency-services intervention. `disruption` is the otherwise
    unspecified `Betriebsstörung`.
  - Extension rule: add normalized keywords or a deliberately positioned category. A rising
    share of `unknown` indicates missing classification rules.
- `normalizeGermanText` (`src/utils/normalization.ts`) is the canonical normalizer for German-text keyword matching, used by both `relevance.ts` and `cause.ts`. It lowercases and expands umlauts (ä→ae, ö→oe, ü→ue, ß→ss) **before** NFD diacritic stripping, then strips non-alphanumerics — so keywords spelled `ae/oe/ue` match source spellings with umlauts. Always route German keyword matching through it.
- Storage treats `cause` and `causeKeyword` as one classification. A refetch must update both
  when either changes. Use `compareCancellationsBySchedule` anywhere cancellation files are
  rewritten so output ordering remains consistent.

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
