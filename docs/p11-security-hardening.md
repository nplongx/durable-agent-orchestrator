# P11 — Security Hardening

P11 hardens the worker trust boundary and GitHub Actions supply chain.

## Controls

- Workflow actions are pinned to full commit SHAs rather than mutable tags.
- P1/P2/P3 keep explicit least-privilege `permissions`; P3 needs `contents: write` only because checkpoint recovery publishes a Git ref.
- Task payloads are never executed directly by the workflow. `ExecutionManager` remains the sole execution authority and retains its deterministic command allowlist.
- Payload and execution `cwd` must remain inside the checked-out workspace.
- Evidence references must be relative and cannot traverse with `..` or use absolute paths.
- A resumed P9 attempt may rotate `lease_id`/`attempt` while retaining the same job/task identity. The worker rewrites those correlation fields in the evidence payload so the verifier sees the current attempt.
- Checkpoint commits must identify the same job/task before resume correlation is accepted.

GitHub recommends explicit least-privilege workflow permissions and pinning third-party actions to full commit SHAs. citeturn0search0turn0search1

The pinned revisions used here are `actions/checkout` v6.0.3 commit `df4cb1c069e1874edd31b4311f1884172cec0e10` and `actions/upload-artifact` v4.6.2 commit `ea165f8d65b6e75b540449e92b4886f43607fa02`. citeturn1search1turn1search0

## Remaining boundary

The worker runs repository code on an ephemeral GitHub-hosted runner. Therefore the checked-out revision must be treated as untrusted code with access only to the permissions granted to that workflow. Secrets should not be exposed to arbitrary task payloads; GitHub recommends minimum credential permissions and avoiding secret values on command lines. citeturn0search2turn0search11
