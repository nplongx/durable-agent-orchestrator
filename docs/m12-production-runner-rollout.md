# M12 — Production runner-agent rollout

M12 removes the last unsafe ambiguity from the M11 GitHub worker boundary: `execution_mode=agent` is production-valid only when an explicit runner-agent executable is configured.

## Ownership

```text
LOCAL ADAPTER
  proposal / approval / DAG / durable state / dispatch / reconcile

GITHUB RUNNER
  lease-owned task execution
  runner-agent lifecycle
  artifact/evidence production

OPENCLAW
  optional runtime used by the configured runner-agent
  never controlled directly by the local adapter for standard-engineering
```

## Production contract

The P3 workflow must provide:

```text
RUNNER_AGENT_COMMAND       executable available on the runner
RUNNER_AGENT_ARGS_JSON     optional JSON array of string arguments
RUNNER_AGENT_TIMEOUT_MS    optional timeout, default 15 minutes
```

The repository-provided production runner is `scripts/runner-agent-openclaw.js`. It launches OpenClaw in embedded/local mode with an isolated temporary state directory and an OpenAI API model provider. The GitHub Actions workflow injects only `OPENAI_API_KEY` as a secret; no local ChatGPT/OpenClaw profile or browser state crosses the runner boundary.

The repository currently requires the GitHub Actions repository secret `OPENAI_API_KEY`. The optional repository variable `RUNNER_AGENT_MODEL` selects the OpenAI model; the default is `openai/gpt-5.6-luna`.

The worker writes `runner-agent-input.json` and exposes its path as `RUNNER_AGENT_INPUT`. The agent receives `RUNNER_AGENT_SESSION_ID` and must emit exactly one JSON object on stdout. A non-zero exit, timeout, malformed JSON, or missing command fails the task.

The local M11 mock remains available only behind `M11_RUNNER_MODE=mock`; it is not a production fallback.

## Safety boundary

- Production `agent` tasks cannot silently synthesize role evidence.
- The local adapter does not receive or forward OpenClaw credentials to the worker.
- The runner-agent executable and its configuration are operator-controlled deployment inputs.
- Existing execution/evidence verification remains the success authority.
- Legacy `engineering` is unchanged.

## Verification

```bash
npm run test:m12-runner-agent
npm run test:worker-protocol
npm run test:standard-engineering
```

The production rollout is not considered complete until a real GitHub Actions runner has `OPENAI_API_KEY`, a real OpenClaw agent session executes the task, and schema-valid evidence reaches the same P3 result contract.
