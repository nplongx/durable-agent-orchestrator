# Runalith MCP bundle

Runalith is a local-first, durable workflow runtime exposed through the Model Context Protocol (MCP). The installable `.mcpb` file is a standard bundle container for compatible clients; it is not tied to one assistant vendor.

From the repository root, build and validate a local candidate:

```sh
npm run pack:runalith-mcpb
```

The packer prints the exact candidate path, size, and SHA-256. It validates the archive, smoke-tests the extracted stdio MCP runtime, checks all manifest tool schemas, and runs the local acceptance suite. A generated candidate is not automatically a production-approved release.

Runalith persists workflow state locally, gates execution on explicit approval, binds deterministic work to immutable plans, validates typed artifacts and provenance, and records recovery events. It does not provide a hosted model or a remote execution fleet.
