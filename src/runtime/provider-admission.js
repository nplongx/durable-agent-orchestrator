import crypto from 'node:crypto';

export const ProviderStates = Object.freeze({
  READY: 'READY',
  IN_USE: 'IN_USE',
  COOLDOWN: 'COOLDOWN',
  PROBE: 'PROBE'
});

const HARD_BLOCK_MS = Math.max(60_000, Number(process.env.PROVIDER_HARD_BLOCK_COOLDOWN_MS) || 20 * 60_000);
const LEASE_MS = Math.max(30_000, Number(process.env.PROVIDER_ADMISSION_LEASE_MS) || 10 * 60_000);

function nowIso() { return new Date().toISOString(); }
function token(prefix = 'admit') { return `${prefix}_${crypto.randomUUID()}`; }

export function isProviderRateLimitError(value) {
  const text = String(value?.message || value || '');
  return /rate_limit_hard_block|chatgpt rate limit|rate limit|too many requests/i.test(text);
}

export class ProviderAdmissionController {
  constructor(store, { hardBlockMs = HARD_BLOCK_MS, leaseMs = LEASE_MS } = {}) {
    this.store = store;
    this.hardBlockMs = hardBlockMs;
    this.leaseMs = leaseMs;
    this.ensureSchema();
  }

  ensureSchema() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_admission (
        provider_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('READY','IN_USE','COOLDOWN','PROBE')),
        cooldown_until TEXT,
        in_flight INTEGER NOT NULL DEFAULT 0,
        consecutive_rate_limits INTEGER NOT NULL DEFAULT 0,
        last_success_at TEXT,
        last_error_at TEXT,
        probe_after TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_admission_leases (
        lease_id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES provider_admission(provider_id),
        job_id TEXT,
        task_id TEXT,
        role TEXT,
        state TEXT NOT NULL CHECK (state IN ('ACTIVE','RELEASED','EXPIRED')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        released_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_provider_admission_lease_provider ON provider_admission_leases(provider_id, state, expires_at);
    `);
  }

  syncProviders(ids = []) {
    const ts = nowIso();
    const insert = this.store.db.prepare(`INSERT OR IGNORE INTO provider_admission
      (provider_id, state, updated_at) VALUES (?, 'READY', ?)`);
    for (const id of ids.filter(Boolean)) insert.run(String(id), ts);
    this.expireLeases();
  }

  expireLeases() {
    const ts = nowIso();
    const expired = this.store.db.prepare(`SELECT lease_id, provider_id FROM provider_admission_leases
      WHERE state='ACTIVE' AND expires_at <= ?`).all(ts);
    if (!expired.length) {
      this.repairInFlightCounts();
      return 0;
    }
    const tx = this.store.db.exec.bind(this.store.db);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of expired) {
        this.store.db.prepare("UPDATE provider_admission_leases SET state='EXPIRED', released_at=? WHERE lease_id=? AND state='ACTIVE'").run(ts, row.lease_id);
        this.store.db.prepare("UPDATE provider_admission SET in_flight=MAX(0,in_flight-1), state=CASE WHEN cooldown_until IS NOT NULL AND cooldown_until > ? THEN 'COOLDOWN' ELSE 'READY' END, updated_at=? WHERE provider_id=?").run(ts, ts, row.provider_id);
      }
      this.store.db.exec('COMMIT');
    } catch (e) { try { tx('ROLLBACK'); } catch (_) {} throw e; }
    this.repairInFlightCounts();
    return expired.length;
  }

  repairInFlightCounts() {
    const rows = this.store.db.prepare("SELECT provider_id, COUNT(*) AS n FROM provider_admission_leases WHERE state='ACTIVE' GROUP BY provider_id").all();
    const counts = new Map(rows.map(row => [row.provider_id, Number(row.n) || 0]));
    const providers = this.store.db.prepare('SELECT provider_id FROM provider_admission').all();
    const ts = nowIso();
    for (const provider of providers) {
      const inFlight = counts.get(provider.provider_id) || 0;
      this.store.db.prepare(`UPDATE provider_admission SET in_flight=?, state=CASE
        WHEN cooldown_until IS NOT NULL AND cooldown_until > ? THEN 'COOLDOWN'
        WHEN ? > 0 THEN 'IN_USE'
        ELSE CASE WHEN state='PROBE' THEN 'PROBE' ELSE 'READY' END END,
        updated_at=? WHERE provider_id=?`).run(inFlight, ts, inFlight, ts, provider.provider_id);
    }
  }

  reconcileOrphanLeases({ liveTaskIds = new Set(), graceMs = 60_000 } = {}) {
    this.expireLeases();
    const cutoff = Date.now() - Math.max(0, Number(graceMs) || 0);
    const active = this.store.db.prepare("SELECT * FROM provider_admission_leases WHERE state='ACTIVE'").all();
    let released = 0;
    for (const lease of active) {
      const task = lease.task_id ? this.store.getTask(lease.task_id) : null;
      const childTask = lease.role && lease.job_id
        ? this.store.db.prepare("SELECT * FROM tasks WHERE job_id = ? AND parent_task_id = ? AND lower(role) = lower(?) ORDER BY created_at DESC LIMIT 1")
          .get(lease.job_id, lease.task_id || '', lease.role)
        : null;
      const effectiveTask = childTask || task;
      const taskStatus = String(effectiveTask?.status || '').toLowerCase();
      // Terminal child runtime is authoritative: release its provider lease
      // immediately. Grace applies only to fresh non-terminal dispatches.
      if (!effectiveTask || ['completed', 'failed', 'cancelled'].includes(taskStatus)) {
        this.release(lease.lease_id, { success: taskStatus === 'completed', reason: 'terminal task lease reconciled' });
        released++;
        continue;
      }
      const createdAt = Date.parse(lease.created_at || 0);
      if (!Number.isFinite(createdAt) || createdAt > cutoff) continue;
      if (effectiveTask && liveTaskIds.has(effectiveTask.task_id)) continue;
      const sessionKey = effectiveTask?.openclaw_session_key || null;
      // A lease is orphaned when its durable task is terminal or its runtime
      // session is no longer present in authoritative OpenClaw inventory.
      // Keep fresh leases untouched to avoid racing a just-dispatched spawn.
      if (effectiveTask && taskStatus === 'running' && sessionKey && liveTaskIds.has(effectiveTask.task_id)) continue;
      if (effectiveTask && ['pending', 'running'].includes(taskStatus) && sessionKey && !liveTaskIds.has(effectiveTask.task_id)) {
        this.release(lease.lease_id, { success: false, reason: 'orphaned runtime lease reconciled' });
        released++;
        continue;
      }
    }
    return released;
  }

  _normalize(row) {
    if (!row) return null;
    const cooldown = row.cooldown_until ? Date.parse(row.cooldown_until) : 0;
    const probeAfter = row.probe_after ? Date.parse(row.probe_after) : 0;
    const now = Date.now();
    let state = row.state;
    if (state === ProviderStates.COOLDOWN && cooldown && cooldown <= now && row.in_flight === 0) state = ProviderStates.PROBE;
    if (state === ProviderStates.PROBE && probeAfter && probeAfter > now) state = ProviderStates.COOLDOWN;
    return { ...row, state, cooldownRemainingMs: Math.max(0, cooldown - now), probeReady: state === ProviderStates.PROBE };
  }

  status(providerId) {
    this.expireLeases();
    return this._normalize(this.store.db.prepare('SELECT * FROM provider_admission WHERE provider_id=?').get(String(providerId)));
  }

  all() {
    this.expireLeases();
    return this.store.db.prepare('SELECT * FROM provider_admission ORDER BY provider_id').all().map(r => this._normalize(r));
  }

  markRateLimited(providerId, reason = 'rate_limit_hard_block', cooldownMs = this.hardBlockMs) {
    const id = String(providerId);
    this.syncProviders([id]);
    const until = new Date(Date.now() + cooldownMs).toISOString();
    const ts = nowIso();
    this.store.db.prepare(`UPDATE provider_admission SET state='COOLDOWN', cooldown_until=?, probe_after=?,
      consecutive_rate_limits=consecutive_rate_limits+1, last_error_at=?, updated_at=? WHERE provider_id=?`)
      .run(until, until, ts, ts, id);
    this.store.recordEventForSystem?.('provider.rate_limited', { providerId: id, reason, cooldownUntil: until });
    return this.status(id);
  }

  markSuccess(providerId) {
    const id = String(providerId);
    this.syncProviders([id]);
    const ts = nowIso();
    this.store.db.prepare(`UPDATE provider_admission SET state=CASE WHEN in_flight > 0 THEN 'IN_USE' ELSE 'READY' END,
      cooldown_until=NULL, probe_after=NULL, consecutive_rate_limits=0, last_success_at=?, updated_at=? WHERE provider_id=?`)
      .run(ts, ts, id);
    return this.status(id);
  }

  _allCoolingDown(rows) {
    return rows.length > 0 && rows.every(r => [ProviderStates.COOLDOWN, ProviderStates.IN_USE].includes(r.state) && r.cooldownRemainingMs > 0 || r.state === ProviderStates.COOLDOWN);
  }

  admit({ providerIds, jobId = null, taskId = null, role = null } = {}) {
    const ids = [...new Set((providerIds || []).map(String).filter(Boolean))];
    if (!ids.length) throw new Error('Provider admission has no providers');
    this.syncProviders(ids);
    this.expireLeases();
    const rows = ids.map(id => this.status(id)).filter(Boolean);
    const global = rows.find(r => r.provider_id === 'chatgpt:global');
    if (global && [ProviderStates.COOLDOWN, ProviderStates.IN_USE].includes(global.state)) {
      const err = new Error(`PROVIDER_UNAVAILABLE: global provider gate is ${global.state}; retry after ${Math.ceil((global.cooldownRemainingMs || 0) / 1000)}s`);
      err.code = 'PROVIDER_UNAVAILABLE';
      err.retryAfterMs = global.cooldownRemainingMs || 0;
      err.providerStates = rows;
      throw err;
    }
    const accountRows = rows.filter(r => r.provider_id !== 'chatgpt:global');
    const ready = accountRows.find(r => r.state === ProviderStates.READY && r.in_flight === 0);
    const probe = accountRows.find(r => r.state === ProviderStates.PROBE && r.in_flight === 0);
    const chosen = ready || probe;
    if (!chosen) {
      const earliest = accountRows.filter(r => r.cooldownRemainingMs > 0).sort((a, b) => a.cooldownRemainingMs - b.cooldownRemainingMs)[0];
      const waitMs = earliest?.cooldownRemainingMs || 0;
      const err = new Error(`PROVIDER_UNAVAILABLE: all admitted providers are cooling down; retry after ${Math.ceil(waitMs / 1000)}s`);
      err.code = 'PROVIDER_UNAVAILABLE';
      err.retryAfterMs = waitMs;
      err.providerStates = rows;
      throw err;
    }
    const leaseId = token('provider_lease');
    const created = nowIso();
    const expires = new Date(Date.now() + this.leaseMs).toISOString();
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.db.prepare(`UPDATE provider_admission SET state='IN_USE', in_flight=in_flight+1, updated_at=? WHERE provider_id=?`).run(created, chosen.provider_id);
      this.store.db.prepare(`INSERT INTO provider_admission_leases(lease_id,provider_id,job_id,task_id,role,state,created_at,expires_at)
        VALUES(?,?,?,?,?,'ACTIVE',?,?)`).run(leaseId, chosen.provider_id, jobId, taskId, role, created, expires);
      this.store.db.exec('COMMIT');
    } catch (e) { try { this.store.db.exec('ROLLBACK'); } catch (_) {} throw e; }
    return { leaseId, providerId: chosen.provider_id, expiresAt: expires };
  }

  release(leaseId, { success = true, rateLimited = false, reason = null } = {}) {
    const lease = this.store.db.prepare("SELECT * FROM provider_admission_leases WHERE lease_id=? AND state='ACTIVE'").get(leaseId);
    if (!lease) return null;
    if (rateLimited) this.markRateLimited(lease.provider_id, reason || 'rate_limit_hard_block');
    const ts = nowIso();
    this.store.db.prepare("UPDATE provider_admission_leases SET state='RELEASED', released_at=? WHERE lease_id=? AND state='ACTIVE'").run(ts, leaseId);
    this.store.db.prepare("UPDATE provider_admission SET in_flight=MAX(0,in_flight-1), updated_at=? WHERE provider_id=?").run(ts, lease.provider_id);
    if (success && !rateLimited) this.markSuccess(lease.provider_id);
    else this.store.db.prepare("UPDATE provider_admission SET state=CASE WHEN cooldown_until IS NOT NULL AND cooldown_until > ? THEN 'COOLDOWN' ELSE 'READY' END, updated_at=? WHERE provider_id=?").run(ts, ts, lease.provider_id);
    return this.status(lease.provider_id);
  }
}
