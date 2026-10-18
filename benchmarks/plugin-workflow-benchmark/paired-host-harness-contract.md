# Paired host harness contract (Phase 2 preparation)

This harness is infrastructure only. It must not be used to infer scenario scores, and it does not make Phase 2 started or authorized.

## Adapter contract

`paired-host-harness.mjs` launches the same host executable sequentially for the `plugin` and `control` conditions, passes byte-identical prompt text and a unique run ID, and gives each condition a fresh private workspace, data directory, and execution temp directory. Child processes receive a minimal environment with no inherited API keys, user config paths, or arbitrary environment variables. The host adapter must connect the frozen 1.0.8 bundle only in the plugin condition and provide basic tools only in the control condition. The host adapter itself must enforce no network, no external provider credentials, and no access to the shared live runtime.

Each child reads one JSON request line from stdin and emits exactly one JSON response line to stdout. Diagnostics belong on stderr. Required response shape:

```json
{
  "protocol": "cos-paired-host-v1",
  "run_id": "copied from request",
  "condition": "plugin or control",
  "probe_only": true,
  "prompt_sha256": "sha256 of exact UTF-8 prompt bytes",
  "model": { "provider": "observed provider", "id": "observed model id" },
  "invocation": { "actual_model_invocation": true, "synthetic_or_scripted": false },
  "tool_trace": [
    { "kind": "model_tool_call", "native": true, "tool_name": "observed name", "arguments": {}, "timestamp": "ISO-8601" },
    { "kind": "tool_result", "native": true, "tool_name": "observed name", "result_sha256": "...", "timestamp": "ISO-8601" }
  ],
  "raw_trace": { "path": "absolute path inside this condition's isolated root", "sha256": "..." },
  "permission_snapshot": {
    "captured_by_host": true,
    "effective_tools": ["actual effective tool names"],
    "authorization_policy": "observed effective policy"
  },
  "environment": {
    "workspace_path": "exact path from request",
    "data_directory": "exact path from request",
    "execution_tmp_directory": "exact path from request",
    "external_network_used": false,
    "external_provider_credentials_used": false,
    "live_runtime_targeted": false,
    "initial_fixture_sha256": "...",
    "final_fixture_sha256": "..."
  }
}
```

The `native` flags are assertions from the host's actual model/tool event stream, not values inferred from final prose. The harness verifies the raw trace file exists inside that condition's isolated root and matches its SHA-256. The raw trace must contain the underlying host-native model/tool events; the summary events alone are insufficient evidence.

## Gate and limitations

The runner creates the same synthetic `benchmark-fixture.json` in each fresh workspace and supplies its exact path/hash to the adapter. It rejects missing model identity, differing models or prompts, scripted invocations, missing native model-tool-call/result events, missing/hash-mismatched raw trace files, missing effective permission snapshots, non-isolated paths, external network/credentials, live-runtime targeting, changed or mismatched read-only fixture state, a plugin condition without an observed `orchestrator_health` call, a control condition without a basic-tool call, or plugin-only capabilities leaking into the control condition. Failure writes a bounded `blocked` evidence record and exits nonzero. Success means only that the host contract passed a benign read-only probe; the ten scenarios still require the frozen Phase 1 test cards, an explicit gate review, and separate authorization.

Current known candidates (isolated OpenClaw through the local adapter, and direct adapter function-calling) have not emitted native tool calls in prior bounded probes. The ChatGPT agent tool layer did return a real read-only plugin result, but does not yet expose the paired reproducible adapter/permission contract required here. Do not invent a passing adapter or convert synthetic tests into readiness evidence.
