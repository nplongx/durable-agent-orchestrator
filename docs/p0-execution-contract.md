# P0 — Execution Contract

P0 khóa contract giữa **control plane** và mọi execution provider.

## Request

`TaskExecutionRequest` gồm:

- `schema_version`
- `job_id`
- `task_id`
- `lease_id`
- `attempt`
- `role`
- `input_commit`
- `task_payload_ref`
- `workspace`
- `required_evidence`

Provider không được tự tạo workflow state. `job_id`, `task_id`, `lease_id`, `attempt` và `input_commit` là correlation/reproducibility boundary.

## Result

`TaskExecutionResult` gồm:

- `schema_version`
- `job_id`
- `task_id`
- `lease_id`
- `attempt`
- `status`
- `input_commit`
- `output_commit`
- `exit_code`
- `provider_run_id`
- `evidence_artifact`
- `evidence_refs`
- `started_at`
- `finished_at`
- `error`

`SUCCEEDED` bắt buộc có `exit_code=0`, `output_commit` và evidence.

`FAILED`/`TIMED_OUT` phải có error hoặc exit code.

## Boundary

```text
LangGraph / Scheduler
        |
        | TaskExecutionRequest
        v
Provider adapter
        |
        v
ephemeral worker
        |
        | TaskExecutionResult
        v
Provider adapter
        |
        v
deterministic verifier
```

GitHub-specific fields không nằm trong generic contract. GitHub Actions run ID được biểu diễn bằng `provider_run_id`; artifact location bằng `evidence_artifact`/`evidence_refs`.

## P0 acceptance

- Request/result được validate strict.
- Attempt bắt đầu từ `1`.
- Git commit boundary được validate.
- Unknown fields bị reject.
- Success không thể thiếu output commit/evidence.
- Contract không biết GitHub Actions.
- Chưa thay đổi workflow state, scheduler hoặc provider admission.
