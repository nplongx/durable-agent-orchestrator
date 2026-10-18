import crypto from 'node:crypto';
import { createExecutionRequest } from './execution-contract.js';
import { parseStrictJson } from './strict-json.js';
import {
  assertProviderDispatchIntent,
  canonicalProviderDispatchRequest,
  createProviderDispatchIdentity,
  ensureProviderDispatchIntentColumns,
  providerDispatchConfig,
  providerDispatchKey,
  providerDispatchIdentityFromIntent
} from './provider-dispatch-identity.js';

const uuid = () => `lease_${crypto.randomUUID()}`;

export class DistributedScheduler {
  constructor({ store, provider, maxParallel = 4, leaseTtlMs = 120000, workerId = `scheduler-${process.pid}` } = {}) {
    if (!store || !provider) throw new Error('DistributedScheduler requires store and provider');
    if (typeof provider.dispatch !== 'function' && typeof provider.reconcileDispatchIntent !== 'function') {
      throw new Error('DistributedScheduler provider must expose dispatch(request) or reconcileDispatchIntent(intent)');
    }
    if (!Number.isSafeInteger(maxParallel) || maxParallel < 1) {
      throw new Error('DistributedScheduler maxParallel must be a positive safe integer');
    }
    if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1 || leaseTtlMs > 2_147_483_647) {
      throw new Error('DistributedScheduler leaseTtlMs must be a positive safe integer no greater than 2147483647');
    }
    if (typeof workerId !== 'string' || !workerId.trim()) throw new Error('DistributedScheduler workerId must be a non-empty string');
    this.store = store;
    this.provider = provider;
    this.maxParallel = maxParallel;
    this.leaseTtlMs = Math.max(5000, leaseTtlMs);
    this.workerId = workerId;
    if (!store.db.__p6Fake && typeof store.db.exec === 'function') {
      store.db.exec(`CREATE TABLE IF NOT EXISTS provider_dispatch_intents (
        dispatch_key TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        owner_epoch INTEGER,
        provider TEXT NOT NULL,
        input_commit TEXT NOT NULL,
        request_sha256 TEXT,
        request_json TEXT,
        api_base TEXT,
        workflow TEXT,
        repository TEXT,
        event TEXT,
        ref TEXT,
        state TEXT NOT NULL,
        provider_run_id TEXT,
        dispatch_claim_id TEXT,
        dispatch_claimed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ); CREATE INDEX IF NOT EXISTS idx_provider_dispatch_intents_state ON provider_dispatch_intents(state, created_at);`);
      ensureProviderDispatchIntentColumns(store.db);
    }
  }

  _activeCount() {
    return this.store.db.prepare("SELECT COUNT(*) AS n FROM task_leases WHERE state='ACTIVE'").get().n;
  }

  _taskPayloadRef(task) {
    const payload = task.payload_ref || task.task_payload_ref || `.worker/tasks/${task.task_id}.json`;
    return payload;
  }

  _resumeCommit(task, fallback) {
    try {
      const metadata = parseStrictJson(task.metadata_json || '{}', 'durable task metadata');
      return metadata.resume_input_commit || metadata.checkpoint_commit || fallback;
    } catch { return fallback; }
  }

  async dispatchTask(task, { inputCommit, role = task.role || 'executor', requiredEvidence = ['task-payload.json', 'execution.json', 'stdout.txt', 'stderr.txt', 'git-status.txt'], taskPayloadInline = null } = {}) {
    // Recovery-only providers intentionally implement reconciliation without
    // exposing dispatch. Reject misuse before taking a lease or persisting a
    // dispatch intent, so a missing capability cannot strand the task.
    if (typeof this.provider.dispatch !== 'function') {
      throw new Error('DistributedScheduler provider does not support new dispatch');
    }
    const existing = this.store.db.__p6Fake
      ? null
      : this.store.db.prepare(`SELECT * FROM task_leases WHERE task_id=? AND state='ACTIVE' LIMIT 1`).get(task.task_id);
    if (existing?.lease_id) {
      let providerRuns = [];
      let dispatchIntents = [];
      try {
        providerRuns = this.store.db.prepare('SELECT * FROM provider_runs WHERE lease_id=? ORDER BY created_at ASC, rowid ASC').all(existing.lease_id);
        dispatchIntents = this.store.db.prepare('SELECT * FROM provider_dispatch_intents WHERE lease_id=? ORDER BY created_at ASC, rowid ASC').all(existing.lease_id);
      } catch {}
      if (providerRuns.length > 1 || dispatchIntents.filter(row => row.dispatch_claim_id || row.provider_run_id).length > 1) {
        throw new Error('task lease has ambiguous provider-run/dispatch-intent cardinality: ' + task.task_id);
      }
      if (providerRuns.length === 1) {
        const providerRun = providerRuns[0];
        const matchingIntents = dispatchIntents.filter(row => row.provider_run_id === providerRun.provider_run_id && row.state === 'DISPATCHED');
        if (providerRun.job_id !== existing.job_id || providerRun.task_id !== task.task_id ||
            providerRun.lease_id !== existing.lease_id || providerRun.attempt !== existing.attempt ||
            !Number.isSafeInteger(providerRun.owner_epoch) || providerRun.owner_epoch !== existing.owner_epoch ||
            matchingIntents.length !== 1) {
          throw new Error('task provider run lacks exact task/lease/attempt/owner-epoch/intent binding: ' + task.task_id);
        }
        return { task, lease: existing, run: providerRun, idempotent: true };
      }
      throw new Error('task already leased without persisted provider run: ' + task.task_id);
    }
    const leaseId = uuid();
    const lease = this.store.acquireTaskLease(task.task_id, {
      leaseId, workerId: this.workerId, ttlMs: this.leaseTtlMs
    });
    const request = createExecutionRequest({
      job_id: task.job_id,
      task_id: task.task_id,
      lease_id: lease.lease_id,
      attempt: lease.attempt,
      owner_epoch: Number(lease.owner_epoch),
      role,
      input_commit: this._resumeCommit(task, inputCommit),
      task_payload_ref: this._taskPayloadRef(task),
      workspace: 'ephemeral',
      required_evidence: requiredEvidence,
      ...(taskPayloadInline ? { task_payload_inline: taskPayloadInline } : {})
    });
    const dispatchIdentity = createProviderDispatchIdentity(request, providerDispatchConfig(this.provider));
    const dispatchKey = providerDispatchKey(dispatchIdentity);
    if (!this.store.db.__p6Fake) {
      // The dispatch key now includes the canonical complete execution request.
      // Also reserve the execution tuple uniquely so a modified payload cannot
      // create a second intent for the same task lease/attempt under a new key.
      const existingAttempts = this.store.db.prepare(`SELECT * FROM provider_dispatch_intents
        WHERE job_id=? AND task_id=? AND lease_id=? AND attempt=? AND provider=? ORDER BY created_at, rowid`)
        .all(dispatchIdentity.job_id, dispatchIdentity.task_id, dispatchIdentity.lease_id,
          dispatchIdentity.attempt, dispatchIdentity.provider);
      if (existingAttempts.length > 1) throw new Error(`multiple durable dispatch intents claim one execution lease/attempt: ${lease.lease_id}`);
      if (existingAttempts.length === 1) assertProviderDispatchIntent(existingAttempts[0], dispatchIdentity);
      const existingIntent = this.store.db.prepare('SELECT * FROM provider_dispatch_intents WHERE dispatch_key=?').get(dispatchKey);
      if (existingIntent) assertProviderDispatchIntent(existingIntent, dispatchIdentity);
      if (existingIntent?.provider_run_id) {
        const run = this.store.db.prepare('SELECT * FROM provider_runs WHERE provider_run_id=?').get(existingIntent.provider_run_id);
        if (!run || run.job_id !== lease.job_id || run.task_id !== task.task_id || run.lease_id !== lease.lease_id ||
            run.attempt !== lease.attempt || run.owner_epoch !== lease.owner_epoch || run.dispatch_key !== dispatchKey ||
            run.request_sha256 !== existingIntent.request_sha256 || existingIntent.state !== 'DISPATCHED') {
          throw new Error(`resolved dispatch intent has no exact matching provider-run ledger row: ${dispatchKey}`);
        }
        return { task, lease, request, run, idempotent: true };
      }
      if (existingIntent?.state === 'DISPATCHING') {
        throw new Error(`provider dispatch intent pending reconciliation: ${dispatchKey}`);
      }
      this.store.db.prepare(`INSERT OR IGNORE INTO provider_dispatch_intents
        (dispatch_key,job_id,task_id,lease_id,attempt,owner_epoch,provider,input_commit,request_sha256,request_json,api_base,workflow,repository,event,ref,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DISPATCHING',?,?)`)
        .run(dispatchKey, dispatchIdentity.job_id, dispatchIdentity.task_id, dispatchIdentity.lease_id,
          dispatchIdentity.attempt, dispatchIdentity.owner_epoch, dispatchIdentity.provider, dispatchIdentity.input_commit, dispatchIdentity.request_sha256,
          canonicalProviderDispatchRequest(request), dispatchIdentity.api_base,
          dispatchIdentity.workflow, dispatchIdentity.repository, dispatchIdentity.event, dispatchIdentity.ref,
          new Date().toISOString(), new Date().toISOString());
      const reserved = this.store.db.prepare('SELECT * FROM provider_dispatch_intents WHERE dispatch_key=?').get(dispatchKey);
      if (!reserved) throw new Error(`durable provider dispatch intent reservation was not persisted: ${dispatchKey}`);
      assertProviderDispatchIntent(reserved, dispatchIdentity);
    }
    try {
      const run = await this.provider.dispatch({ ...request, dispatch_key: dispatchKey });
      if (!this.store.db.__p6Fake) {
        if (run?.provider_run_id) {
          this.store.db.prepare(`UPDATE provider_dispatch_intents SET state='DISPATCHED', provider_run_id=?, updated_at=?
            WHERE dispatch_key=? AND state IN ('DISPATCHING','DISPATCHED') AND (provider_run_id IS NULL OR provider_run_id=?)`)
            .run(String(run.provider_run_id), new Date().toISOString(), dispatchKey, String(run.provider_run_id));
          const bound = this.store.db.prepare('SELECT state,provider_run_id FROM provider_dispatch_intents WHERE dispatch_key=?').get(dispatchKey);
          if (!bound || bound.state !== 'DISPATCHED' || String(bound.provider_run_id) !== String(run.provider_run_id)) {
            throw new Error(`provider dispatch result conflicts with the durable dispatch-intent binding: ${dispatchKey}`);
          }
        } else {
          this.store.db.prepare(`UPDATE provider_dispatch_intents SET state='DISPATCHING', updated_at=?
            WHERE dispatch_key=? AND state='DISPATCHING' AND provider_run_id IS NULL`)
            .run(new Date().toISOString(), dispatchKey);
          const pending = this.store.db.prepare('SELECT state,provider_run_id FROM provider_dispatch_intents WHERE dispatch_key=?').get(dispatchKey);
          if (!pending || pending.state !== 'DISPATCHING' || pending.provider_run_id !== null) {
            throw new Error(`provider dispatch outcome conflicts with the durable dispatch-intent binding: ${dispatchKey}`);
          }
        }
      }
      this.store.db.prepare(`UPDATE task_leases SET last_error=NULL WHERE lease_id=?`).run(lease.lease_id);
      this.store.recordEvent(task.job_id, run?.provider_run_id ? 'task.provider.dispatched' : 'task.provider.dispatch_pending', {
        taskId: task.task_id, leaseId: lease.lease_id, attempt: lease.attempt,
        providerRunId: run?.provider_run_id || null, dispatchKey
      }, lease.lease_id);
      return { task, lease, request, run };
    } catch (error) {
      // Once a durable dispatch intent exists, an exception is not by itself
      // proof that no workflow was accepted remotely. Do not expire the task
      // lease on an ambiguous timeout/API/binding failure: doing so could make
      // a second attempt run while the first remote workflow is still active.
      // Only an explicitly pre-send failure may release this lease here.
      const intent = this.store.db.__p6Fake ? null : this.store.db.prepare(
        'SELECT * FROM provider_dispatch_intents WHERE dispatch_key=?'
      ).get(dispatchKey);
      if (intent && error?.remoteOutcome !== 'not_sent' && ['DISPATCHING', 'DISPATCHED', 'COMPLETED'].includes(String(intent.state))) {
        const run = intent.provider_run_id
          ? this.store.db.prepare('SELECT * FROM provider_runs WHERE provider_run_id=?').get(String(intent.provider_run_id))
          : null;
        return {
          task, lease, request, run: run || { provider_run_id: null, state: 'DISPATCHING', pending_reconciliation: true },
          pending_reconciliation: true, dispatch_error: String(error?.message || error)
        };
      }
      this.store.expireTaskLease(lease.lease_id, { reason: `dispatch_failed: ${error.message}` });
      throw error;
    }
  }

  async reconcileProviderDispatches({ maxAgeMs = 15 * 60 * 1000 } = {}) {
    if (this.store.db.__p6Fake || typeof this.provider.reconcileDispatchIntent !== 'function') return [];
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    // Never age out a stranded intent: process death can occur at any point.
    // Unclaimed modern intents are exposed as explicitly safe pre-send retries;
    // claimed intents are lookup-only because a remote side effect is possible.
    const intents = this.store.db.prepare("SELECT * FROM provider_dispatch_intents WHERE state='DISPATCHING' ORDER BY created_at ASC").all();
    const results = [];
    for (const intent of intents) {
      const output = { dispatchKey: intent.dispatch_key, createdAt: intent.created_at };
      try {
        const siblingIntents = this.store.db.prepare(`SELECT dispatch_key,dispatch_claim_id,provider_run_id FROM provider_dispatch_intents
          WHERE lease_id=? AND task_id=? AND attempt=? AND provider=? AND dispatch_key<>? ORDER BY created_at ASC, rowid ASC`)
          .all(intent.lease_id, intent.task_id, intent.attempt, intent.provider, intent.dispatch_key);
        if (siblingIntents.length > 0) {
          results.push({ ...output, status: 'AMBIGUOUS_SIBLING_DISPATCH_INTENTS_REQUIRES_OPERATOR',
            can_retry_pre_send: false, remote_lookup_performed: false, sibling_count: siblingIntents.length });
          continue;
        }
        if (!intent.request_sha256 || !intent.request_json || !intent.api_base || !intent.workflow || !intent.repository || !intent.ref) {
          results.push({ ...output, status: 'LEGACY_UNBOUND_REQUIRES_OPERATOR', remote_lookup_performed: false });
          continue;
        }
        const expected = providerDispatchIdentityFromIntent(intent);
        assertProviderDispatchIntent(intent, expected);
        if (!intent.dispatch_claim_id) {
          if (!intent.request_json) {
            results.push({ ...output, status: 'UNCLAIMED_REQUEST_UNAVAILABLE_REQUIRES_OPERATOR', remote_lookup_performed: false });
            continue;
          }
          const request = parseStrictJson(intent.request_json, 'durable provider dispatch request');
          const expectedFromRequest = createProviderDispatchIdentity(request, providerDispatchConfig(this.provider));
          assertProviderDispatchIntent(intent, expectedFromRequest);
          const lease = this.store.db.prepare('SELECT * FROM task_leases WHERE lease_id=?').get(String(intent.lease_id));
          const now = new Date(this.store.clock?.() ?? Date.now()).toISOString();
          if (!lease || lease.state !== 'ACTIVE' ||
              String(lease.job_id) !== String(intent.job_id) || String(lease.task_id) !== String(intent.task_id) ||
              Number(lease.attempt) !== Number(intent.attempt) || Number(lease.owner_epoch) !== Number(intent.owner_epoch) ||
              typeof lease.expires_at !== 'string' || lease.expires_at <= now) {
            results.push({ ...output, status: 'LEASE_STALE_NO_SEND', can_retry_pre_send: false, remote_lookup_performed: false });
            continue;
          }
          results.push({ ...output, status: 'SAFE_PRE_SEND_RETRY_AVAILABLE', can_retry_pre_send: true, remote_lookup_performed: false });
          continue;
        }
        const run = await this.provider.reconcileDispatchIntent(intent);
        if (!run) {
          const sendReference = intent.dispatch_claimed_at || intent.created_at;
          results.push({ ...output, status: sendReference < cutoff ? 'STALE_AMBIGUOUS_REQUIRES_OPERATOR' : 'NOT_FOUND_RECONCILIATION_ONLY', remote_lookup_performed: true });
          continue;
        }
        for (const field of ['job_id', 'task_id', 'lease_id', 'attempt', 'owner_epoch', 'input_commit', 'workflow', 'ref']) {
          const expected = intent[field];
          const actual = run[field];
          const matches = field === 'attempt' || field === 'owner_epoch'
            ? Number.isSafeInteger(Number(actual)) && Number(actual) === Number(expected)
            : field === 'input_commit'
              ? typeof actual === 'string' && actual.toLowerCase() === String(expected).toLowerCase()
              : typeof actual === 'string' && actual === String(expected);
          if (actual === undefined || actual === null || !matches) {
            throw new Error(`reconciled provider run does not match exact durable ${field} binding`);
          }
        }
        const p3Provider = String(this.provider.workflow || '').includes('p3-worker');
        if (p3Provider &&
            (!/^\d+$/.test(String(run.provider_run_id || '')) || !Number.isSafeInteger(Number(run.run_attempt)) || Number(run.run_attempt) < 1)) {
          throw new Error('reconciled P3 provider run lacks validated numeric run ID or positive run_attempt');
        }
        if (p3Provider) {
          // A run observation alone is not a durable terminal identity. The
          // provider must atomically bind the same run to both the intent and
          // provider_runs ledger before the scheduler may acknowledge it.
          const ledger = this.store.db.prepare('SELECT * FROM provider_runs WHERE provider_run_id=?').get(String(run.provider_run_id));
          if (!ledger || ledger.provider !== 'github-actions' ||
              String(ledger.dispatch_key || '') !== String(intent.dispatch_key) ||
              String(ledger.request_sha256 || '') !== String(intent.request_sha256) ||
              String(ledger.job_id || '') !== String(intent.job_id) ||
              String(ledger.task_id || '') !== String(intent.task_id) ||
              String(ledger.lease_id || '') !== String(intent.lease_id) ||
              Number(ledger.attempt) !== Number(intent.attempt) ||
              Number(ledger.owner_epoch) !== Number(intent.owner_epoch) ||
              String(ledger.input_commit || '').toLowerCase() !== String(intent.input_commit).toLowerCase() ||
              String(ledger.workflow || '') !== String(intent.workflow) ||
              String(ledger.ref || '') !== String(intent.ref) ||
              Number(ledger.run_attempt) !== Number(run.run_attempt)) {
            throw new Error('reconciled P3 run is not durably bound to the exact dispatch key/request digest in provider_runs');
          }
        }
        this.store.db.prepare(`UPDATE provider_dispatch_intents SET state='DISPATCHED', provider_run_id=?, updated_at=?
          WHERE dispatch_key=? AND state='DISPATCHING' AND provider_run_id IS NULL
            AND request_sha256=? AND dispatch_claim_id=?`)
          .run(String(run.provider_run_id), new Date().toISOString(), intent.dispatch_key, intent.request_sha256, intent.dispatch_claim_id);
        const bound = this.store.db.prepare('SELECT * FROM provider_dispatch_intents WHERE dispatch_key=?').get(intent.dispatch_key);
        if (!bound || bound.state !== 'DISPATCHED' || String(bound.provider_run_id) !== String(run.provider_run_id) ||
            bound.request_sha256 !== intent.request_sha256 || bound.dispatch_claim_id !== intent.dispatch_claim_id) {
          throw new Error(`reconciled provider run conflicts with the durable dispatch-intent binding: ${intent.dispatch_key}`);
        }
        results.push({ ...output, status: 'RECONCILED', run, remote_lookup_performed: true });
      } catch (error) {
        results.push({ ...output, status: 'RECONCILIATION_ERROR', remote_effect_remains_ambiguous: Boolean(intent.dispatch_claim_id), error: String(error?.message || error) });
      }
    }
    return results;
  }

  async retryPreSendDispatch(dispatchKey) {
    if (this.store.db.__p6Fake || typeof this.provider.dispatch !== 'function') {
      throw new Error('pre-send dispatch recovery requires the real durable SQLite store and provider');
    }
    if (typeof dispatchKey !== 'string' || !/^[a-f0-9]{64}$/i.test(dispatchKey)) {
      throw new Error('pre-send dispatch recovery requires a 64-character hexadecimal dispatch key');
    }
    const intent = this.store.db.prepare('SELECT * FROM provider_dispatch_intents WHERE dispatch_key=?').get(dispatchKey);
    if (!intent) throw new Error('pre-send dispatch recovery intent was not found');
    if (intent.state !== 'DISPATCHING' || intent.provider_run_id) throw new Error('only an unresolved DISPATCHING intent can be retried');
    if (intent.dispatch_claim_id) {
      throw new Error('dispatch send claim already exists; remote effect may have occurred, so reconciliation only is allowed');
    }
    const siblingIntents = this.store.db.prepare(`SELECT dispatch_key FROM provider_dispatch_intents
      WHERE lease_id=? AND task_id=? AND attempt=? AND provider=? AND dispatch_key<>? ORDER BY created_at ASC, rowid ASC`)
      .all(intent.lease_id, intent.task_id, intent.attempt, intent.provider, intent.dispatch_key);
    if (siblingIntents.length > 0) {
      throw new Error('multiple dispatch intents claim the same lease/attempt; operator reconciliation is required and retry is forbidden');
    }
    if (!intent.request_json || !intent.request_sha256) {
      throw new Error('legacy or incomplete intent lacks immutable request bytes; operator reconciliation is required and retry is forbidden');
    }
    const request = parseStrictJson(intent.request_json, 'durable provider dispatch request');
    const requestIdentity = createProviderDispatchIdentity(request, providerDispatchConfig(this.provider));
    assertProviderDispatchIntent(intent, requestIdentity);
    const lease = this.store.db.prepare('SELECT * FROM task_leases WHERE lease_id=?').get(intent.lease_id);
    const now = new Date(this.store.clock?.() ?? Date.now()).toISOString();
    if (!lease || lease.state !== 'ACTIVE' || lease.task_id !== intent.task_id || lease.job_id !== intent.job_id ||
        Number(lease.owner_epoch) !== Number(intent.owner_epoch) ||
        Number(lease.attempt) !== Number(intent.attempt) || !(lease.expires_at > now)) {
      return { dispatchKey, status: 'LEASE_STALE_NO_SEND', sent: false, reason: 'the original exact lease is not active and unexpired' };
    }
    // Provider.dispatch owns the one-way SQLite claim CAS. If another process
    // claims after this read, it reconciles instead of issuing another POST.
    const run = await this.provider.dispatch({ ...request, dispatch_key: dispatchKey });
    if (run?.provider_run_id) {
      this.store.db.prepare(`UPDATE provider_dispatch_intents SET state='DISPATCHED',provider_run_id=?,updated_at=?
        WHERE dispatch_key=? AND state IN ('DISPATCHING','DISPATCHED') AND (provider_run_id IS NULL OR provider_run_id=?)
          AND request_sha256=?`)
        .run(String(run.provider_run_id), new Date().toISOString(), dispatchKey, String(run.provider_run_id), intent.request_sha256);
    }
    const persisted = this.store.db.prepare('SELECT * FROM provider_dispatch_intents WHERE dispatch_key=?').get(dispatchKey);
    if (!persisted || persisted.request_sha256 !== intent.request_sha256 ||
        (run?.provider_run_id && String(persisted.provider_run_id) !== String(run.provider_run_id))) {
      throw new Error('pre-send retry result conflicts with the original immutable dispatch intent');
    }
    this.store.recordEvent(intent.job_id, 'task.provider.pre_send_recovery', {
      taskId: intent.task_id, leaseId: intent.lease_id, attempt: Number(intent.attempt), dispatchKey,
      providerRunId: persisted.provider_run_id || null, pendingReconciliation: !persisted.provider_run_id
    }, intent.lease_id);
    return { dispatchKey, status: persisted.provider_run_id ? 'RETRIED_AND_BOUND' : 'RETRIED_PENDING_RECONCILIATION', run: run || null };
  }

  async dispatchPending({ inputCommit, limit = this.maxParallel } = {}) {
    const capacity = Math.max(0, this.maxParallel - Number(this._activeCount()));
    if (!capacity) return [];
    const tasks = this.store.listRunnableTasks({ limit: Math.min(capacity, limit) });
    const results = [];
    // Lease acquisition is synchronous/atomic; dispatch calls may run in parallel
    // after each task has its unique lease.
    for (const task of tasks) {
      if (this.store.db.__p6Fake) {
        // Test doubles can model capacity without a backing lease table.
      } else if (this._activeCount() >= this.maxParallel) break;
      results.push(this.dispatchTask(task, { inputCommit }));
    }
    return Promise.allSettled(results);
  }
}
