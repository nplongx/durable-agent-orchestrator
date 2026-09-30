# M9 — Governance / Permissions

## Contract

Agent contracts are the source of truth for role permissions. Governance validates permission use instead of treating contract metadata as advisory.

## Session access

Session permissions are durable and auditable:

- `OBSERVE`
- `MESSAGE`
- `EXECUTE`
- `TAKEOVER`

`TAKEOVER` is never implicit. Session owner receives implicit `OBSERVE`, `MESSAGE`, and `EXECUTE` only.

## Grant authority

- `system` and `cto` may grant any session permission.
- A session owner may grant non-`TAKEOVER` permissions to another role.
- Other roles cannot grant access.

## Revoke authority

`system`, `cto`, session owner, or access recipient may revoke a grant.

All grant/revoke operations emit durable events. Expired/revoked grants never satisfy authorization checks.

Legacy `engineering` behavior remains unchanged.
