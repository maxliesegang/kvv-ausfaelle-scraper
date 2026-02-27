# Workflow Agents

Guidance in this file applies to `.github/workflows/**`.
This is the most specific guidance for workflow files.

## Purpose

The primary automation agent is `.github/workflows/update-data.yml`, which runs the scraper on a schedule and publishes new data.

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

## Failure Behavior

- Network issues are bounded by `FETCH_TIMEOUT_MS`.
- Individual parse failures should not silently hide systemic parser regressions.
- No changes: skip commit/push.
- Build/test failures should fail the workflow visibly.

## Required Permissions

- `contents: write` for commit/push.
- default `GITHUB_TOKEN` from Actions runtime.

## Validation Checklist For Workflow Changes

1. Run locally: `npm run dev`
2. Parser tests: `npm run test:parser`
3. Type check: `npm run type-check`
4. Formatting check: `npm run format:check`
5. Manual workflow dispatch before merge
