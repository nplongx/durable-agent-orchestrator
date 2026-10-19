# Documentation rewrite workflow

This is the working agreement for rewriting and maintaining the repository documentation. The goal is to make common tasks discoverable, instructions reproducible, and technical claims traceable to implementation—not to increase the number of pages or diagrams.

## Editorial model

Use four page types, based on the [Diátaxis/Divio documentation system](https://docs.divio.com/documentation-system/):

| Type | Reader's question | Writing contract | Example in this repo |
|---|---|---|---|
| Tutorial | “Can you help me learn by doing?” | A complete path with prerequisites, numbered actions, expected results, and a known-good end state. | [Quickstart](quickstart.md) |
| How-to guide | “How do I complete this task?” | Solve one specific problem with the fewest reliable steps; link out for concepts and reference. | [Dashboard guide](local-dashboard.md) |
| Reference | “What does this interface accept or guarantee?” | Accurate, structured descriptions of fields, tools, errors, limits, and supported values. | [Workflow policies](workflow-policies.md) |
| Explanation | “Why is it designed this way?” | Explain concepts, trade-offs, trust boundaries, and failure behavior without disguising proposals as shipped features. | [Architecture](architecture.md) |

A page may link to another page type, but should have one primary purpose. Do not turn the root README into the full API manual.

## Rewrite phases

Work in small, reviewable slices. Do not rewrite all historical files in one pass.

### Phase 1 — Inventory and information architecture

1. List every maintained Markdown page, its audience, page type, current status, and source-of-truth locations.
2. Identify duplicate descriptions, missing user journeys, stale links, unsupported claims, and historical records presented as current behavior.
3. Establish one canonical page for each topic and link to it from other pages rather than copying the full explanation.
4. Mark plans, proposals, benchmark evidence, and point-in-time candidate records as historical/scoped material. Preserve audit records; do not silently delete or rewrite them as though they were current product docs.

**Exit criteria:** the root README is a short entrypoint; users can find the Quickstart and feature guides from one index; historical documents are labeled as such; every active topic has an owner/canonical destination or an explicit gap.

### Phase 2 — Rewrite the user journey

Rewrite and verify in this order:

1. Root README and documentation index.
2. Quickstart: install, health check, inspect templates, and understand approval before execution.
3. Task guides: dashboard, workflow proposal/approval/recovery, policy packs, Agent Skills, and hybrid execution.
4. Reference: exact MCP tool inputs/outputs, supported predicates, environment variables, states/errors, and storage contracts.
5. Explanations: architecture, trust boundaries, recovery semantics, and design trade-offs.

Do not mark a phase complete just because the prose exists. Follow the relevant commands and example tool calls in a clean local checkout or fixture, and record anything that cannot be reproduced.

### Phase 3 — Verify claims against implementation

For each page, identify the relevant evidence before writing:

- Public interface: the shipped entrypoint, MCP tool registration and schemas.
- Behavior: the runtime implementation and its state/permission checks.
- Data contract: schema, migrations, artifact contract, or protocol definition.
- Expected behavior: focused regression tests and fixtures.
- Operational claims: actual scripts, environment-variable readers, configuration defaults, and package contents.

Tests support a claim only for the behavior they exercise. Passing unit tests do not establish production readiness, live integration, user experience quality, or external exactly-once delivery. Keep unverified limits explicit.

### Phase 4 — Technical writing and review

For each change, answer these questions before requesting review:

1. **Audience:** who is this page for, and what should they be able to do/understand afterwards?
2. **Prerequisites:** are required software, permissions, workspace state, and setup steps explicit?
3. **Outcome:** does each procedure state what success looks like and what to do when it fails?
4. **Accuracy:** can every tool name, field, default, state transition, and security claim be traced to code/tests?
5. **Scope:** are unsupported features, assumptions, version constraints, and limitations clearly called out?
6. **Navigation:** can the reader reach this page from the README/index and follow links to prerequisite concepts without dead ends?
7. **Maintenance:** is this the canonical location, and is copied information replaced by a link?

Review from three perspectives: a new user following the instructions literally, an operator debugging a failed workflow, and a maintainer checking a claim against code. Security-sensitive documentation needs an additional boundary review.

### Phase 5 — Automated checks and merge

Before merging documentation changes:

```bash
npm run docs:check
git diff --check
```

When a page documents behavior affected by code changes, run the relevant focused test and report the exact command and outcome. For user procedures, verify commands and defaults against the current checkout; for schema/API changes, compare the docs with the source schema and regression tests. Do not rely only on a spelling/Markdown linter.

CI runs the documentation checks for each pull request. Reviewers should reject claims that are not supported by the implementation, procedures that omit a necessary approval/safety step, broken links, and new user-facing links to generated HTML that GitHub cannot render inline.

## Quality gate

A page is ready only when all applicable items pass:

- The page has one clear primary audience and purpose.
- The title and opening explain what the reader gets, not merely the internal component name.
- Steps can be followed in order and have an observable expected result.
- Commands, tool names, parameters, outputs, defaults, and links were verified.
- Risks, permissions, approval requirements, and non-goals are explicit where relevant.
- The page links to canonical related docs instead of duplicating entire sections.
- Markdown renders usefully on GitHub without requiring interaction with a committed standalone HTML file.
- The documentation check and whitespace check pass; relevant product tests pass when behavior is being described.

Do not count page length, diagrams, generated output, or a successful link check as a proxy for documentation quality.

## Rules for diagrams and generated material

- Prefer prose and code examples when they explain behavior more clearly.
- Keep diagrams supplementary. Commit a GitHub-renderable format such as Mermaid in Markdown or a static image preview; never make standalone interactive HTML the only way to understand a concept.
- A diagram does not replace its accompanying explanation or override code/tests.
- Generated files must have a clear user value, a repeatable generation path, and a defined review surface. Keep transient render receipts and other machine-local artifacts out of the repository.

## Reference material

- [GitHub: About README files](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) — use the README to explain what the project does, why it is useful, how to get started, and where help lives; keep deeper manuals in linked pages.
- [GitHub: Contributing guidelines](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors) — put contribution expectations where GitHub can surface them to issue and pull-request authors.
- [Google developer documentation style guide](https://developers.google.com/style) — use clear, consistent technical language and a consistent style.
- [Diátaxis / Divio documentation system](https://docs.divio.com/documentation-system/) — separate tutorials, how-to guides, reference, and explanation by reader intent.

## Current rewrite backlog

| Priority | Scope | Acceptance criterion |
|---|---|---|
| P0 | README, docs index, quickstart, documentation checks | A newcomer can find the install/health path; active navigation and local links are checked in CI. |
| P1 | Workflow tasks, dashboard, policies, Agent Skills, hybrid workflow | Each page has one purpose, tested steps, and a clear failure/permission model. |
| P2 | MCP tool/reference catalog and data contracts | Public tools/fields/states are complete and match the shipped schemas and tests. |
| P3 | Architecture and recovery explanation | Current architecture is explained from the shipped local entrypoint; proposals/distributed experiments are labeled separately. |
| P4 | Historical `m*`/`p*` plans and benchmark/evidence records | Each record has scope/status/date context and cannot be mistaken for current usage instructions or release authorization. |

Only close a backlog row after its acceptance criteria have been reviewed. This file records the process; it is not a claim that the whole backlog has already been completed.
