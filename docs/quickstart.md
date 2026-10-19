# Quickstart

This guide takes a new contributor from a clean checkout to a locally installed plugin whose MCP tools respond. It does not authorize a real workflow or a release.

## Prerequisites

- Node.js **22.13 or newer** and npm.
- Chat On Steroids for installing the plugin.
- `tmux` only if you intend to exercise deterministic local execution tasks.

## 1. Install dependencies and run the acceptance suite

```bash
git clone https://github.com/nplongx/durable-agent-orchestrator.git
cd durable-agent-orchestrator
npm ci
npm test
```

The test suite uses local test fixtures and is intended to verify the plugin's current contracts. A passing suite does not certify autonomous model-worker quality, a live OpenClaw/Gateway integration, exactly-once external side effects, or production readiness.

## 2. Build a candidate bundle

```bash
npm run pack:chat-on-steroids-plugin
```

The packer creates a uniquely named `.mcpb` candidate under `dist/`, validates the staged archive, smoke-tests its extracted MCP entrypoint, and runs package/integration checks. Use the exact path printed by the command. The repository's ignored `dist/` output is local build output, not source to commit.

## 3. Install it in Chat On Steroids

For local development only:

1. Open **Plugins** in Chat On Steroids and install the candidate file produced in the previous step.
2. Enable **Local Agent Orchestrator** and select the workspace the plugin should operate on.
3. Refresh the **Chat On Steroids Plugins** connector in ChatGPT.
4. Call `orchestrator_health`, then `workflow_catalog`.

The MCP entrypoint runs over stdio. It does not open port `8318`; that port belongs to the optional dashboard. If the health tool is unavailable, check that the plugin is enabled, the connector has been refreshed, and the correct plugin candidate was installed before debugging workflow behavior.

## 4. Understand the approval boundary before running work

The normal lifecycle is:

1. Call `workflow_create` to create a proposal. Proposal creation does not authorize execution.
2. Inspect the returned proposal and intended work. Only proceed when the plan is acceptable.
3. Call `workflow_approve` to explicitly approve the proposal and compile its immutable plan.
4. Call `workflow_dispatch` to start the approved workflow, or use `workflow_coordinator_step` to advance the approved lifecycle through the higher-level coordinator API.
5. Inspect task state, events, results, and artifacts. Successful completion requires the runtime's evidence and synthesis gates; do not treat a model's narrative as proof that work completed.

The required input schema for each operation is exposed by the tool itself. Start with `workflow_catalog` to inspect available templates. When experimenting, use a disposable workspace and a low-risk task, inspect all proposed deterministic work before approval, and do not point a local execution workflow at a production checkout or data directory.

## 5. Optional: start the read-only dashboard

In a separate terminal:

```bash
npm run dashboard
```

Open the URL printed by the server (default: `http://127.0.0.1:8318`). The dashboard reads existing SQLite records and exposes no approval, dispatch, or mutation controls. Keep it on loopback; it is not designed to be exposed remotely. See the [dashboard guide](local-dashboard.md) for configuration and security details.

## Next steps

- [Architecture](architecture.md) explains the runtime and durable-state boundaries.
- [Workflow policies](workflow-policies.md) explains supported constraints and success predicates.
- [Agent Skills](agent-skills.md) explains how role guidance is imported, versioned, and bounded.
- [Contributing](../CONTRIBUTING.md) explains the test and review expectations for changes.

If you are trying to verify a release candidate rather than develop locally, stop here and follow the formal authorization and review process referenced in [Known issues](KNOWN_ISSUES.md). Building and installing a candidate is not release approval.
