# Local Agent Orchestrator — Chat On Steroids plugin

The installable MCPB bundle is built from the `manifest.json` in this directory and canonical runtime sources. Use the bundle for installation so the complete runtime dependency graph is packaged and checked.

From the repository root:

```sh
npm run pack:chat-on-steroids-plugin
```

The command prints the exact path and SHA-256 of a newly created, versioned **candidate** bundle under `dist/`. Inspect that reported candidate and its independent release authorization before installing it; the command does not create or replace the frozen release bundle. The packer collects the local runtime dependency graph, excludes the legacy HTTP adapter and cloud-provider modules, validates the archive, and launches the extracted MCP server for an end-to-end smoke test.

The plugin owns durable SQLite workflow state, explicit approvals, dependency-aware local tasks, typed artifacts, and terminalization guards. Reasoning runs in the host conversation; deterministic commands execute on the local machine through the approved execution contract.
