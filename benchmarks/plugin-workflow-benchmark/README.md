# Plugin Workflow Benchmark Run Evidence

This directory contains benchmark protocol files, preparation evidence, and the single authorized CASE-01 pilot record. The pilot failed/unverified in the plugin condition; no rubric score or Phase 2 go decision is recorded.

For each case and condition, create a new run directory using a unique timestamp/ID and copy `run-manifest.template.json` to `run-manifest.json`. Keep evidence artifacts in that run directory, not inside the temporary execution workspace. Do not place credentials, personal data, or customer data here.

Before issuing any scenario prompt, verify and record:

1. Target bundle SHA-256 matches the frozen value in `docs/plugin-workflow-benchmark-preflight-evidence.md`.
2. Plugin and basic-tools conditions use equivalent prompts, tool capabilities, runtime dependencies, and initial fixtures, except for the plugin being evaluated.
3. Each condition has its own disposable workspace, SQLite data directory, and execution-temp directory. Never use the shared live runtime database or a workspace containing unrelated work.
4. `OPENAI_API_KEY` and other external-provider credentials are absent unless a separately approved test requires them.
5. Approval state, available tools, environment identity, and initial fixture hashes have been captured before the run.

Save the exact input, tool/event trace, resulting artifacts, independent verification output, artifact hashes, intervention log, rubric scores, hard-fail decision, and final status. Missing evidence is `unverified`, not `pass`. Do not run a baseline until the run manifest is complete and the target/permission snapshot is frozen.

The original preflight record predates the CASE-01 pilot below and should be read as historical preparation evidence.

`phase2-runner-readiness-review.md` is the supplemental gate review. `scenario-execution-spec-v1.json` defines the ten scenario prompts, synthetic starting states, case-level constraints, and independent verifier contracts; it is planning-only and explicitly `prepared-not-authorized`. Validate it with `node benchmarks/plugin-workflow-benchmark/test-scenario-execution-spec.mjs`. This does not start Phase 2 or authorize scenario execution. `scenario-paired-harness.mjs` and `ollama-scenario-adapter.mjs` are a gated runner prototype; their offline gate test must pass before any later authorization.

`ollama-tool-loop.mjs` is the bounded, fail-closed multi-turn model/tool-loop primitive intended for that runner. Its offline contract tests are `node benchmarks/plugin-workflow-benchmark/test-ollama-tool-loop.mjs`; the tests use a mocked model endpoint and do not invoke Ollama, plugin tools, or any scenario.

`scenario-basic-tools.mjs` implements the common bounded filesystem/fixture tools and synthetic timeout/health/artifact fixtures. Run `node benchmarks/plugin-workflow-benchmark/test-scenario-basic-tools.mjs` for offline policy tests. These unit tests exercise only temporary synthetic workspaces; they do not issue benchmark prompts or start plugin workflows.

`scenario-verifiers.mjs` contains independent outcome checks for all ten frozen case IDs. Its tests are `node benchmarks/plugin-workflow-benchmark/test-scenario-verifiers.mjs`; they use fabricated traces/artifacts and do not call a model or plugin.

`scenario-paired-harness.mjs` is the paired case runner. Its default path is deliberately blocked before creating workspaces or issuing prompts. Actual execution requires both `--authorize-scenario-execution`, `COS_BENCHMARK_AUTHORIZED=yes`, and a versioned gate record. The single CASE-01 authorization has now been consumed and the v2 gate is closed. The gate contract is tested by `node benchmarks/plugin-workflow-benchmark/test-scenario-paired-harness-gate.mjs`.

Run `node benchmarks/plugin-workflow-benchmark/validate-scenario-policy.mjs` for static validation of the frozen bundle identity, case-specific tool allowlists, hard-deny rules, and the blocked authorization record. This reads only the bundle manifest and never starts the plugin or model.

The last offline validation summary is `runs/phase2-preparation-20261010/policy-validation-20261010.json`. It explicitly records remaining blockers: plugin-specific orchestration benefit and plugin SQLite/event evidence are not yet reconciled with the artifact verifiers, and the adapter is not an OS sandbox. Passing the static tests does not make the runner ready or start Phase 2.

## Supplemental Phase 2 preparation (2026-10-11)

- `scenario-sandbox.mjs` launches the frozen plugin child under Bubblewrap and a transient systemd user scope with network/PID isolation, case-local writable mounts, and cgroup resource limits. `test-scenario-sandbox.mjs` is a benign containment test; `test-scenario-sandbox-plugin-preflight.mjs` starts the frozen bundle under that sandbox and performs only MCP initialize/tools-list/read-only health. Its evidence is `runs/phase2-preparation-20261010/sandbox-plugin-preflight-20261011.json`.
- `plugin-state-export.mjs` captures a read-only export from only the condition-local SQLite DB and verifies its identity/hash/path. `test-plugin-state-export.mjs` exercises both positive and negative paths.
- `trace-integrity.mjs` reconciles model-native tool attempts to exactly one executor disposition and plugin RPC attempts to terminal results/errors. Run `node benchmarks/plugin-workflow-benchmark/test-trace-integrity.mjs` for synthetic negative tests.
- The paired harness checks trace integrity and the plugin-state export before a successful condition can be recorded. A verifier pass still does **not** prove plugin orchestration benefit: the export explicitly marks workspace-artifact causality false unless a future reviewed design establishes that relation.
- `phase1-gate-adjudication-20261011.md` resolves the freeze wording conservatively without editing the frozen Phase 1 file. `phase2-full-preparation-audit-20261011-v2.md` is the consolidated audit.

**Historical preparation decision:** runner infrastructure was hardened, but the v1 protocol did not establish plugin workflow-to-artifact causality. The v1 spec remains frozen and unchanged. The later v2 protocol and pilot result below supersede the preparation-only readiness statement; the official Phase 1 manifest remains `not-started`.

## Execution-backed Phase 2 v2 protocol (2026-10-11)

The v1 scenario spec remains unchanged. `scenario-execution-spec-v2.json` is a separate protocol that preserves all ten frozen user prompts byte-for-byte and adds a condition-neutral system context, case-specific isolated workflow grants, and explicit artifact/trace lineage acceptance rules. See `phase2-execution-backed-contract-v2-20261011.md`.

- `plugin-artifact-lineage.mjs` independently reconciles the plugin's custom role/workflow definitions, preview and approval hashes, private job/plan/task/result/artifact/synthesis records, terminal state, and exact workspace file hashes. It has explicit failure-state, health-trace, proposal-only, and read-only modes.
- `test-plugin-artifact-lineage.mjs` covers positive artifact/task/synthesis linkage and negative cases for changed file bytes, missing approval/synthesis, dispatch in CASE-06, failed task state, and health-observation trace linkage.
- `test-scenario-execution-spec-v2.mjs` checks the consumed one-time v2 gate, frozen source hash, prompt parity, CASE-06 hard denies, and read-only cases.
- `validate-scenario-policy-v2.mjs` validates the frozen bundle identity, per-case tool grants, lineage hooks, and the consumed authorization record without starting a plugin or model.
- The paired harness and adapter accept `--spec-version 2`. The explicitly authorized CASE-01 pilot has run once; the gate is now `consumed`, so the CLI/environment flags cannot authorize another run.
- Final consolidated run: `phase2-full-preparation-audit-20261011-v4.md`; machine-readable evidence: `runs/phase2-preparation-20261010/phase2-preparation-evidence-v2-20261011-rerun.json`.

The v2 unit tests use synthetic evidence fixtures and are not a benchmark result. The single real pilot report is `phase2-pilot-review-CASE-01-20261011.md`; its outcome is **FAIL / UNVERIFIED for the plugin condition**, with no score and no Phase 2 deployment approval. Any retry or additional case requires new explicit authorization.
