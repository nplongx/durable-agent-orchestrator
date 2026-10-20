# Local monitoring dashboard

The Runalith dashboard is an optional, local-only, read-only web interface for inspecting the runtime's existing SQLite records. It runs as a separate process from the MCP stdio server, does not create a second workflow database, and does not expose workflow approval, dispatch, retry, or mutation operations.

The dashboard is a separate process and opens the workflow database read-only. See the [architecture explanation](architecture.md#dashboard) for its trust boundary and the [static architecture illustrations](diagrams/README.md) for a supplementary overview.

## Start and configure

From the repository root, run:

```bash
npm run dashboard
```

The server prints its URL and database path. The default URL is `http://127.0.0.1:8318`. Stop it with `Ctrl+C`.

| Environment variable | Purpose | Default / accepted values |
|---|---|---|
| `RUNALITH_DATA_DIR` | Internal workflow data directory and default database location | `~/.runalith/agent-orchestrator` on new installs; an existing data directory is preserved automatically |
| `RUNALITH_DASHBOARD_FILES_ROOT` | Root browsed by Local files Explorer | Current working directory when launched from the workspace root; set an absolute path to browse elsewhere |
| `CHAT_ON_STEROIDS_DASHBOARD_FILES_ROOT` | Compatibility alias for the Explorer root | Used when `RUNALITH_DASHBOARD_FILES_ROOT` is unset |
| `RUNALITH_WORKFLOW_DB` | SQLite database path | `workflow.db` under the resolved data directory; omit to use the default |
| `RUNALITH_DASHBOARD_PORT` | HTTP port | `8318` |
| `RUNALITH_DASHBOARD_HOST` | Listener address | `127.0.0.1` or `::1` only |

The host is deliberately restricted to loopback. A non-loopback host value is rejected instead of exposing the dashboard on a LAN or public interface. If another process uses the default port, select an unused port using `RUNALITH_DASHBOARD_PORT`.

## What it shows

- **Overview:** workflow/task counts, recent activity, runtime/database health, and a *Needs attention* queue.
- **Workflows:** filter and inspect workflow status, phase, progress, tasks, approvals, transitions, results, artifacts, and reports.
- **Roles & skills:** inspect custom-role versions, attached Agent Skills snapshots and hashes, exact role-version pins in custom workflows, and opt-in custom profile overlays proposed for built-in `standard-engineering` specialist tasks. Built-in runtime roles remain fixed contracts.
- **Batch execution:** inspect durable `execution_batches` and `execution_batch_items` separately from individual task-level `ExecutionManager` records. An individual execution does not become a batch merely because it completed successfully.
- **Event stream and artifacts:** search recorded events and inspect bounded artifact metadata/content previews.
- **File explorer:** list and preview approved text/log files under the configured workspace root. The browse root is separate from the internal workflow database directory; by default, `npm run dashboard` browses the current working directory. Set `RUNALITH_DASHBOARD_FILES_ROOT` (or the `CHAT_ON_STEROIDS_DASHBOARD_FILES_ROOT` compatibility alias) to pin a different root.

The global search is for workflows; events and artifacts have separate search controls. The page refreshes automatically every 20 seconds while visible. The refresh controls briefly indicate an in-flight snapshot and expose a last-sync/error state without discarding the last successful snapshot. The Workbench Activity Bar remains available on narrow screens; the primary navigation sidebar collapses on small viewports. Keyboard users can press `/` to focus global workflow search; `Ctrl/Cmd+Shift+P` opens the local command palette and `Escape` closes it. These are local presentation behaviors; the dashboard remains read-only. Workflow pins and filters are stored in `sessionStorage` for the current tab session only and are not written to the workflow database. Copy controls report clipboard failures instead of silently treating them as success.

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
| `GET /api/files?path=...` | Directory listing under the configured Explorer files root |
| `GET /api/files/preview?path=...` | Bounded preview of an allowed text/log file |
| `GET /api/git/status?path=...` | Best-effort Git status for supported text files under the configured workspace root |
| `GET /api/git/diff?path=...&mode=working-tree\|staged\|unstaged` | Bounded read-only Git patch for an allowed file; mode defaults to `working-tree` |

Unknown routes return `404`. API requests using a method other than `GET` are rejected with `405`. The root HTML and local CSS/JavaScript assets are served from the bundled `dashboard/public/` directory; assets are not fetched from a CDN.

### Built-in role profile overlays

The **Built-in role profile overlays** table reads the latest proposal binding per workflow from the event ledger. It shows built-in role, custom profile identity/version, profile SHA-256, Skill names and workflow status. A row records proposal intent; it does **not** prove the workflow was approved, dispatched, or completed. The API exposes bounded metadata only, not raw system prompts, Skill contents, or local source paths. Overlay bindings are currently accepted only for `standard-engineering`; built-in contracts and runtime permissions remain authoritative.

## Security and data boundaries

- SQLite opens with `readOnly: true`, `PRAGMA query_only=ON`, and `PRAGMA trusted_schema=OFF`. The dashboard is an observer; use the MCP workflow tools to make authorized changes.
- Requests are checked against the expected `Host`; supplied `Origin` headers must also be same-origin and loopback. Response headers disable caching and include a restrictive Content Security Policy and `X-Content-Type-Options: nosniff`.
- Responses and text previews are bounded. The file explorer resolves entries beneath one configured browse root, independent from the database directory. Precedence is `options.filesRoot`, `RUNALITH_DASHBOARD_FILES_ROOT`, `CHAT_ON_STEROIDS_DASHBOARD_FILES_ROOT`, explicitly supplied `options.dataDir` for compatibility, then `process.cwd()`. Health responses expose only the basenames `data_root` and `files_root`, never absolute paths. The Explorer rejects traversal and symbolic links, excludes hidden paths, database/WAL files and binary content, and only previews approved text/log extensions. Large files are not returned in full.
- Common credential patterns are redacted on a best-effort basis. Redaction is heuristic and cannot guarantee detection of every secret. Keep the local data directory's filesystem permissions restrictive.
- Browser assets are local; the dashboard does not call external APIs or send telemetry.

Loopback binding reduces network exposure but is not user authentication. This dashboard is for a trusted local operator, not a shared or remotely deployable admin console. Do not expose it through a reverse proxy, port forward, or shared host without a separately designed authentication and security boundary.

## Test

Run the dashboard's integration/security regression test with:

```bash
npm run test:dashboard
```

The test builds a temporary SQLite fixture and verifies read-only access, bounded responses, workflow/role/batch views, file-browser restrictions, redaction, Host/Origin checks, and rejection of write methods. It does not certify broader production readiness or guarantee that heuristic secret redaction catches every sensitive value.


## Workbench layout and Git inspection

The dashboard uses a local Workbench shell inspired by editor layouts: Activity Bar, existing domain navigation, central view with a selected-view tab and breadcrumb, collapsible bottom panel, and compact status bar. All eight existing domains remain available: Overview, Workflows, Roles & Skills, Policies, Batches/individual executions, Event Stream, Artifacts, and Explorer. The shell is presentation-only; it does not add workflow mutation controls.

Explorer shows a visible **Configured root** and a lazy-loaded directory tree. The root is the dashboard's configured files root, not an automatically detected active folder in an IDE. Set \`RUNALITH_DASHBOARD_FILES_ROOT\` (or its compatibility alias) to switch roots; restarting the dashboard applies configuration changes. The workspace search walks supported directory listings recursively with caps of 40 folders, 1,000 entries, and 100 matches. When a cap is reached, the UI marks the results as limited. File previews remain bounded and read-only.

When the configured root is within a Git repository, Source Control reads status through \`git status --porcelain=v2 -z\`. File decorations distinguish supported modified, added, deleted, renamed, copied, untracked, type-changed, and conflict records when Git reports them. Directory decorations summarize descendant changes. Index and working-tree status are exposed separately by the API. Git status is best-effort: timeout, output bounds, unsupported paths, and non-Git roots can make status unavailable. The dashboard never stages, unstages, commits, checks out, resets, or reverts files.

Explorer includes an Open Editors list with multiple read-only tabs. Supported text previews use line numbers; Source Control exposes explicit working-tree, staged, and unstaged diff modes. The diff is a bounded unified patch rendered locally. This lightweight viewer avoids downloading Monaco or other remote assets and is not a full language-aware editor: syntax highlighting and advanced side-by-side diff navigation are not provided. Browser-verified mobile interaction remains unverified because the desktop browser tunnel is unavailable. Automated integration tests alone do not prove accessibility conformance.
