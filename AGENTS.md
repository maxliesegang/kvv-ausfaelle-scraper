# Agents

This is the canonical repository guidance for coding agents. Tool-specific instruction files,
including `CLAUDE.md`, should only point here rather than duplicate these rules.

This repository uses path-scoped `AGENTS.md` files to minimize context.
When multiple files apply, use the closest file to the edited path as the most specific guidance.

## Global Scope

- Project goal: scrape KVV cancellation-style notices, extract structured trip cancellation data, and publish generated artifacts under `docs/`.
- Data model rule: cancellation data and train-line definitions are organized by **Fahrplan year**, not calendar year.
- Published records use the `Cancellation` contract in `src/types.ts`; keep persisted field names
  backward-compatible unless a migration is explicitly part of the task.
- Terminology:
  - **article/notice**: one KVV detail page and source URL
  - **trip**: one parsed journey affected by that article
  - **cancellation**: the persisted structured trip record
  - **classification**: the paired `cause` and `causeKeyword` evidence
  - **Fahrplan year**: the timetable-period bucket used for storage and mappings
- Primary commands:
  - `npm run dev`
  - `npm run build`
  - `npm run lint`
  - `npm test`
  - `npm run test:unit`
  - `npm run type-check`
  - `npm run format:check`

## Naming

- Prefer domain names over chronology or implementation history. Name parser formats by field
  shape (for example, stop/time order and required parentheses), not "old" or "new".
- Include scope in lookup names when identity changes across boundaries, such as source-scoped or
  line-scoped trip keys.
- Name counters by the entity and outcome they count (`tripsRestored`,
  `articlesWithParseErrors`, `classificationsUpdated`), not generic verbs such as `changed` or
  `written`.
- Use `line` only for a transit line; call a line of article text a `row`.
- Name Fahrplan-year directories explicitly (`fahrplanYearDirectory`, not `yearDir`), functions
  with verbs, and maps as `<values>By<Key>`.

## Code Conventions

- The project targets Node.js 26+ (pinned in `.nvmrc`) and uses ESM. Prefix built-in imports with `node:` and include
  `.js` extensions on relative imports.
- Prefer shared helpers under `src/utils/` over local reimplementations.
- Treat published JSON field names as contracts, even when a longer internal name would be more
  descriptive.

## Dependency Overrides

`package.json` `overrides` pins `minimatch@^11.0.1` and `glob@^14.0.2`. Both are dev-only
transitive dependencies of `c8` → `test-exclude@8.0.0`, which still requires the vulnerable
`minimatch@^10` (GHSA-g3hv-75wg-m249) and `glob@^13` (GHSA-3g3m-2fjr-6pw4). Whenever `c8` or
`test-exclude` is updated, drop the overrides if the new ranges already include the patched
versions (`npm ls glob minimatch`, `npm audit`); otherwise an override silently holds back a
newer major the dependency asks for. Verify with `npm run test:coverage` — coverage totals must
stay unchanged, since `test-exclude` selects the measured files.

## Path Map

- `/.github/AGENTS.md` - GitHub-level automation and monitoring context.
- `/.github/workflows/AGENTS.md` - workflow schedule, behavior, permissions.
- `/src/AGENTS.md` - scraper pipeline, parsing/relevance architecture, runtime config.
- `/src/parser/AGENTS.md` - parser extraction rules, patterns, and regression checks.
- `/src/train-line-definitions/AGENTS.md` - train-number mapping and Fahrplan-year definition handling.
- `/scripts/AGENTS.md` - one-off data/script maintenance guidance.
- `/docs/AGENTS.md` - published output layout and generated artifact expectations.
- `/tests/AGENTS.md` - test structure and expectations for code changes.
- `/test-data/AGENTS.md` - fixture conventions for parser coverage.
