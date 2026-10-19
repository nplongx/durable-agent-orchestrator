# Contributing

Thanks for helping improve Durable Agent Orchestrator / Local Agent Orchestrator.

## Development setup

- Node.js **22.13 or newer** (Node 22 and 24 are the intended CI lines).
- npm from the selected Node.js installation.
- `tmux` only for tests or workflows that exercise deterministic local execution.

```bash
git clone https://github.com/nplongx/durable-agent-orchestrator.git
cd durable-agent-orchestrator
npm ci
npm test
```

## Before opening a pull request

Run the checks relevant to your change. For a workflow-plan, artifact, or MCP surface change, start with:

```bash
npm run test:protocol
npm run test:workflow-m4
npm test
git diff --check
```

For execution, lease, filesystem, recovery, or package changes, also run the corresponding focused tests under `tests/`. Do not claim a check passed unless you ran it and observed a successful exit status. Mention tests that could not be run and the reason.

For user-visible or architectural changes, update the canonical documentation page and the [documentation index](docs/README.md). Follow the [documentation rewrite workflow](docs/DOCUMENTATION_WORKFLOW.md) to choose the page type, verify claims against code and tests, and check links. Diagrams are optional supporting material; do not add a diagram unless it makes a concept materially easier to understand. GitHub-renderable Markdown or static PNGs are preferred over standalone HTML.

Before opening a documentation-only pull request, run:

```bash
npm run docs:check
git diff --check
```

## Safety and evidence

- Keep changes scoped to the intended feature. Avoid unrelated reformatting and generated snapshots.
- Never commit credentials, `.env` files, personal/customer data, live SQLite databases, runtime logs, `dist/` bundles, or execution/benchmark evidence containing local paths or identifiers.
- Use disposable temporary directories and synthetic fixtures for tests. Do not use the live runtime database or a real workspace as a test fixture.
- Do not run live provider dispatch or a benchmark scenario as part of a unit test. External side effects require explicit authorization and should be tested separately.
- Preserve existing approval, lease, result, artifact-lineage, and recovery safeguards. Missing or ambiguous evidence must remain blocked/unverified rather than being upgraded to success.
- Candidate packages are not releases. Do not overwrite frozen artifacts or alter official authorization/audit records to make a check pass.

## Pull request expectations

Describe the behavior changed and why, summarize compatibility/security implications, list exact tests run, and document known limitations. Include a test for each bug fix where practical. Keep changes reviewable and do not bundle unrelated example applications with the orchestrator runtime.

By submitting a contribution, you agree that it will be distributed under the repository's MIT license.
