# M1 — Agent Contract Layer

Status: **implemented**

M1 makes every agent role executable through one explicit, versioned contract. The contract is metadata and validation only; it does not change provider execution semantics yet.

## Canonical contract

```js
{
  id,
  version,
  role,
  capability,
  executor,
  inputs,
  outputs,
  permissions,
  allowedTools,
  completionCriteria
}
```

### Rules

- `id` is stable and names the role contract, e.g. `agent.engineer`.
- `version` is an integer. Contract changes require a version bump.
- `capability` remains the existing capability registry value.
- `inputs` and `outputs` are named contract fields, not free-form prompts.
- `permissions` is the existing authorization boundary.
- `allowedTools` is an explicit allow-list. An empty list means no tool beyond the executor/runtime boundary is authorized by this contract.
- `completionCriteria` describes what must be true before the role is considered complete. It is declarative metadata in M1; enforcement of durable artifacts/evidence is later milestones.

## Canonical roles

`product-owner`, `researcher`, `architect`, `engineer`, `security`, `qa`, `platform`, `writer`, `reviewer`, `cto` all expose a v1 contract.

The historical `productowner` lookup alias remains for compatibility, but the canonical contract ID is `agent.product-owner`.

## Compatibility

Existing callers may continue using `getRoleContract(role)` and existing `capability`, `executor`, and `permissions` fields. M1 only adds contract metadata and validation APIs.

## API

- `getAgentContract(role)` — return the canonical immutable contract.
- `validateAgentContract(contract)` — validate shape and semantic constraints.
- `listAgentContracts()` — return canonical contracts only, excluding aliases.
- `getRoleContract(role)` — compatibility API backed by the same canonical contracts.

M2 will attach durable artifact schemas to these contracts. M1 deliberately does not persist artifacts or change the database schema.

