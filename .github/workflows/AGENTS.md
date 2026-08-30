# Workflow Agents

Guidance in this file applies to `.github/workflows/**`.
This is the most specific guidance for workflow files.

## Purpose

Two workflows:

- `.github/workflows/update-data.yml` — the primary automation agent: runs the scraper on a
  schedule and publishes new data.
- `.github/workflows/ci.yml` — lint + tests + build on pull requests and on pushes to `main`
  that touch anything outside `docs/`. Data-only commits are skipped here because the scraper
  workflow audits them itself (below).

## Where The Suite Runs

The archive audits (`tests/unit/archive-corpus.test.ts`, `archive-relevance.test.ts`) read
`docs/`, so **committed data can turn the suite red without any code change** — this is not
hypothetical, it has happened. That means the suite belongs in both places:

- `ci.yml` covers code changes.
- `update-data.yml` runs `npm test` _after_ committing and deploying, so newly archived
  articles are audited on the run that produced them while the good data still publishes.

Never move the scraper workflow's test step ahead of the commit/deploy steps: failing there
would withhold data that is already valid.

## Schedule

- Frequency: every 4 hours (6 runs/day)
- UTC times: `00:00`, `04:00`, `08:00`, `12:00`, `16:00`, `20:00`
- Trigger: scheduled + manual dispatch

## Expected Workflow Steps

1. Environment setup:
   - checkout
   - Node.js 22
   - `npm ci`
2. Build and execute:
   - `npm run build`
   - `npm start`
   - `npm run format`
3. Data publication:
   - stage `docs/`
   - commit message: `Update KVV cancellations (docs)`
   - push only if changes exist
4. GitHub Pages deploy (same job):
   - `actions/configure-pages` → `actions/upload-pages-artifact` (path `docs`) → `actions/deploy-pages`
   - guarded by `if: ${{ !cancelled() }}` so committed data still publishes even when the scraper reported errors
   - `docs/` stays committed to git regardless — it is the single source of truth the scraper re-reads for reconciliation; the Pages artifact is just a copy of it
5. Post-publish audit:
   - `npm test` against the just-committed `docs/`, guarded by `if: ${{ !cancelled() }}`
6. Scraper verdict:
   - `Fail if scraper had errors` re-raises the `continue-on-error` scraper step's outcome

## Step Guards

Every step after `npm start` runs on a job that may already be failing, so each one states its
guard deliberately. An `if:` naming no status function (`always()`, `!cancelled()`, `failure()`)
carries an implicit `success()` and is therefore **skipped once any earlier step has failed** —
which is how the scraper's parse-error verdict went missing on runs where the post-publish audit
turned red first. A step whose only job is to report a condition must say `!cancelled() && <the
condition>`, never the bare condition.

## Failure Behavior

- Network issues are bounded by `FETCH_TIMEOUT_MS`.
- Individual parse failures should not silently hide systemic parser regressions.
- No changes: skip commit/push.
- Build/test failures should fail the workflow visibly.

## Required Permissions

- `contents: write` for commit/push.
- `pages: write` + `id-token: write` for the GitHub Pages deploy.
- `environment: github-pages` on the job.
- default `GITHUB_TOKEN` from Actions runtime.

## Repo Setting

Pages source must be **GitHub Actions** (Settings → Pages → Build and deployment → Source), not "Deploy from a branch". The workflow is the sole publisher.

## Validation Checklist For Workflow Changes

1. Run locally: `npm run dev`
2. Parser tests: `npm run test:parser`
3. Type check: `npm run type-check`
4. Formatting check: `npm run format:check`
5. Manual workflow dispatch before merge
