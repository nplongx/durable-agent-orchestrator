# ORBIT / OPS local monitoring dashboard

ORBIT / OPS is an optional, local-only, read-only web interface for inspecting the Local Agent Orchestrator's existing SQLite records. It runs as a separate process from the MCP stdio server, does not create a second workflow database, and does not expose workflow approval, dispatch, retry, or mutation operations.

## Start and configure

From the repository root, run:

```bash
npm run dashboard
```

The server prints its URL and database path. The default URL is `http://127.0.0.1:8318`. Stop it with `Ctrl+C`.

| Environment variable | Purpose | Default / accepted values |
|---|---|---|
| `CHAT_ON_STEROIDS_DATA_DIR` | Data directory containing workflow files and logs | `~/.chat-on-steroids/agent-orchestrator`; `WORKFLOW_DATA_DIR` is the compatibility alias |
| `CHAT_ON_STEROIDS_WORKFLOW_DB` | SQLite database path | `workflow.db` under the resolved data directory; `WORKFLOW_DB` is the compatibility alias |
| `CHAT_ON_STEROIDS_DASHBOARD_PORT` | HTTP port | `8318` |
| `CHAT_ON_STEROIDS_DASHBOARD_HOST` | Listener address | `127.0.0.1` or `::1` only |

The host is deliberately restricted to loopback. A non-loopback host value is rejected instead of exposing the dashboard on a LAN or public interface. If another process uses the default port, select an unused port using `CHAT_ON_STEROIDS_DASHBOARD_PORT`.

## What it shows

- **Overview:** workflow/task counts, recent activity, runtime/database health, and a *Needs attention* queue.
- **Workflows:** filter and inspect workflow status, phase, progress, tasks, approvals, transitions, results, artifacts, and reports.
- **Roles & skills:** inspect custom-role versions, attached Agent Skills snapshots and hashes, exact role-version pins in custom workflows, and opt-in custom profile overlays proposed for built-in `standard-engineering` specialist tasks. Built-in runtime roles remain fixed contracts.
- **Batch execution:** inspect durable `execution_batches` and `execution_batch_items` separately from individual task-level `ExecutionManager` records. An individual execution does not become a batch merely because it completed successfully.
- **Event stream and artifacts:** search recorded events and inspect bounded artifact metadata/content previews.
- **File explorer:** list and preview approved text/log files underneath the configured data directory.

The global search is for workflows; events and artifacts have separate search controls. The page refreshes automatically every 20 seconds while visible. Workflow pins and filters are stored in `sessionStorage` for the current tab session only and are not written to the workflow database. Copy controls report clipboard failures instead of silently treating them as success.

The attention queue evaluates the latest 100 jobs plus session-pinned jobs; it is not a scan of the entire job registry. Failed jobs are prioritized. *Quiet >15m* is shown only when a valid `updated_at` timestamp is older than 15 minutes. It is a staleness heuristic, not proof of failure.

## HTTP API

The browser uses these read-only endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Connection, local mode and read-only health details |
| `GET /api/overview` | Aggregate status/count summaries |
| `GET /api/jobs` | Filtered and paginated workflow registry |
| `GET /api/jobs/:job_id` | One workflow and its bounded related records |
| `GET /api/roles` | Custom role versions, Skill snapshots, custom-workflow version pins, and `builtin_role_profile_pins` for exact built-in role/profile/version/hash references |
| `GET /api/batches` | Durable batch and individual-execution ledgers |
| `GET /api/events` | Filtered event stream |
| `GET /api/artifacts` and `GET /api/artifacts/:artifact_id` | Artifact index and one artifact's bounded detail |
| `GET /api/files?path=...` | Directory listing under the configured data root |
| `GET /api/files/preview?path=...` | Bounded preview of an allowed text/log file |

Unknown routes return `404`. API requests using a method other than `GET` are rejected with `405`. The root HTML and local CSS/JavaScript assets are served from the bundled `dashboard/public/` directory; assets are not fetched from a CDN.

### Built-in role profile overlays

The **Built-in role profile overlays** table reads the latest proposal binding per workflow from the event ledger. It shows built-in role, custom profile identity/version, profile SHA-256, Skill names and workflow status. A row records proposal intent; it does **not** prove the workflow was approved, dispatched, or completed. The API exposes bounded metadata only, not raw system prompts, Skill contents, or local source paths. Overlay bindings are currently accepted only for `standard-engineering`; built-in contracts and runtime permissions remain authoritative.

## Security and data boundaries

- SQLite opens with `readOnly: true`, `PRAGMA query_only=ON`, and `PRAGMA trusted_schema=OFF`. The dashboard is an observer; use the MCP workflow tools to make authorized changes.
- Requests are checked against the expected `Host`; supplied `Origin` headers must also be same-origin and loopback. Response headers disable caching and include a restrictive Content Security Policy and `X-Content-Type-Options: nosniff`.
- Responses and text previews are bounded. The file explorer resolves entries beneath the configured data root, rejects traversal and symbolic links, excludes database/WAL files and binary content, and only previews approved text/log extensions. Large files are not returned in full.
- Common credential patterns are redacted on a best-effort basis. Redaction is heuristic and cannot guarantee detection of every secret. Keep the local data directory's filesystem permissions restrictive.
- Browser assets are local; the dashboard does not call external APIs or send telemetry.

Loopback binding reduces network exposure but is not user authentication. This dashboard is for a trusted local operator, not a shared or remotely deployable admin console. Do not expose it through a reverse proxy, port forward, or shared host without a separately designed authentication and security boundary.

## Test

Run the dashboard's integration/security regression test with:

```bash
npm run test:dashboard
```

The test builds a temporary SQLite fixture and verifies read-only access, bounded responses, workflow/role/batch views, file-browser restrictions, redaction, Host/Origin checks, and rejection of write methods. It does not certify broader production readiness or guarantee that heuristic secret redaction catches every sensitive value.
