# Visual documentation index

These diagrams were authored as native JSON diagrams with [Archify](https://github.com/tt-a1i/archify) 3.2.0. Each interactive HTML artifact is self-contained; the paired PNG is a static preview for GitHub Markdown and offline reading. The source JSON includes a repository revision and source-code references so readers can trace the important claims back to code.

The diagrams describe the runtime and documentation structure at source revision `74a2e7426c1ecc9618ffb0eea8943fa250fec268`. They are documentation views, not an independent security certification, benchmark result, or release authorization.

## System architecture

Shows the MCP entrypoint, workflow compiler, durable SQLite store, deterministic execution manager, immutable policy contract, separate read-only dashboard, and the docs/evidence layer.

[Open the interactive system architecture](rendered/system-architecture.html)

![Durable Agent Orchestrator system architecture](rendered/system-architecture.png)

## Hybrid engineering workflow

Shows the proposal and approval gates, coordinator, nine host-conversation specialist roles, two deterministic local syntax checks, evidence gate, synthesis, and terminal report. The role dependency detail remains in [the hybrid workflow specification](../hybrid-engineering-workflow.md).

[Open the interactive hybrid workflow](rendered/hybrid-engineering.html)

![Hybrid engineering workflow](rendered/hybrid-engineering.png)

## Versioned workflow policy lifecycle

Shows validation, immutable versioning, pre-approval attachment, plan compilation, runtime predicate evaluation, rejection paths, and append-only audit evidence.

[Open the interactive policy lifecycle](rendered/workflow-policy-lifecycle.html)

![Workflow policy pack lifecycle](rendered/workflow-policy-lifecycle.png)

## Repository map

Shows the main maintained areas: runtime and workflow contracts, MCP server, dashboard, protocol, plugin, tests, docs, examples, scripts, and benchmark/readiness evidence.

[Open the interactive repository map](rendered/repository-map.html)

![Durable Agent Orchestrator repository map](rendered/repository-map.png)

## Source and regeneration

- Archify source files: [`source/`](source/)
- Rendered interactive HTML and PNG previews: [`rendered/`](rendered/)
- Rendering helper: [`scripts/render-doc-diagrams.sh`](../../scripts/render-doc-diagrams.sh)
- Upstream tool: [tt-a1i/archify](https://github.com/tt-a1i/archify)

Install or otherwise obtain Archify 3.2.0, then set `ARCHIFY_BIN` to its `bin/archify.mjs` entrypoint and run:

```bash
ARCHIFY_BIN=/path/to/archify/bin/archify.mjs scripts/render-doc-diagrams.sh
```

The helper runs Archify `finalize` and `visual-check` for every diagram and refreshes the 1440×900 light-theme previews. Detailed browser receipts and viewport captures are intentionally ignored by Git; regenerate them when validating a change. If the code responsibilities or relationships change, update the source references and pinned `meta.repository.revision` in the relevant JSON before regenerating. Do not update the pinned revision merely because documentation-only files changed.
