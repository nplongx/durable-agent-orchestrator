# M12 Phase 1b — Gateway-side narrow admission

> **Document type:** Historical milestone record. It captures design, implementation, or validation context for that milestone; it is not by itself proof of current deployment or release readiness.

Status: IMPLEMENTED AS ISOLATED GATEWAY-SIDE CONTRACT

## Scope

Phase 1b implements the narrow privileged boundary required by the frozen M12 architecture:

```text
GitHub OIDC-verified broker
        |
        | exact task/lease binding + expiry
        v
GatewayRunnerAdmissionService
        |
        | Gateway-internal privileged provisioner
        v
Gateway-owned cloud-worker environment/node enrollment
```

The service is deliberately independent of the public Gateway RPC surface. The current OpenClaw `2026.9.5` RPCs expose `environments.create`, `environments.prepare`, and `environments.destroy`, but those methods require `operator.admin` and their public schemas do not expose the complete JIT bootstrap tuple (`environment_id`, `node_setup_id`, `owner_epoch`, lease binding, short-lived bootstrap). Therefore Phase 1b does not pretend that an existing public RPC is sufficient.

## Privilege boundary

`GatewayRunnerAdmissionService` accepts an injected `provisioner` that represents code executing inside the Gateway trust boundary. The runner never supplies an admin credential to this service.

The provisioner MUST:

1. execute only Gateway-owned environment/node lifecycle operations;
2. create exactly one environment admission for the supplied lease binding;
3. use the exact bootstrap profile:

```json
{
  "roles": ["node"],
  "scopes": [],
  "purpose": "cloud-worker"
}
```

4. bind `environment_id`, `node_setup_id`, `owner_epoch`, and `lease_id` to the admission;
5. return a short-lived bootstrap credential;
6. reject stale owner/lease state before and during provisioning;
7. destroy/reclaim the environment through the existing Gateway lifecycle owner when the admission is fenced.

## Service guarantees

- exact binding fields are required;
- idempotency key is recomputed from the binding and must match;
- concurrent identical requests are single-flight;
- `role=node` is reserved for the bootstrap capability and cannot be supplied as the task role;
- issued lease must equal the requested lease;
- issued `owner_epoch` must be a non-negative safe integer;
- issued expiry must be after `now` and no later than the requested fence;
- bootstrap must contain only target + short-lived credential;
- unsafe roles/scopes/purpose fail closed;
- no Gateway admin credential is returned;
- no model/provider credential is returned.

## Current OpenClaw integration point

The native Gateway worker environment runtime already owns the relevant lifecycle internally. In `2026.9.5`, worker environment startup wires `prepareNodeBootstrap` into the worker environment service, and the cloud-worker bootstrap profile is explicitly defined as node-only with empty scopes and `purpose: "cloud-worker"`.

The remaining integration work is therefore a **Gateway-hosted privileged provisioner**, not a runner-side workaround. It must be added through the Gateway/plugin runtime or a narrowly reviewed OpenClaw core extension that can access the internal worker-environment service without exposing `operator.admin` to the runner.

## Not enabled in production

This phase does not:

- install or enable a new OpenClaw plugin;
- restart or modify the live Gateway;
- pair/enroll a real node;
- expose an HTTP admission endpoint;
- grant `operator.admin` to GitHub Actions;
- invoke `sessions.create`/`sessions.spawn` for specialist tasks;
- introduce OpenAI Platform credentials.

Until the Gateway-hosted privileged provisioner is wired to the actual OpenClaw worker environment service and exercised in an isolated Gateway fixture, M12 remains `NOT PROVEN`.
