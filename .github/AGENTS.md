# GitHub Automation Agents

Guidance in this file applies to `.github/**`.
For files in `.github/workflows/**`, prefer the more specific workflow file guidance.

## Monitoring

- Workflow runs: repository Actions tab
- Data update history: commit history
- Pages publication: repository Deployments tab
- Dependency updates: `dependabot.yml` opens monthly grouped PRs for npm and GitHub Actions;
  see `/AGENTS.md` (Dependency Overrides) before merging a `c8` update

## Detailed Workflow Rules

For workflow behavior, schedule, permissions, and validation steps, see `.github/workflows/AGENTS.md`.
