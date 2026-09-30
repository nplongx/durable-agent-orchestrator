import crypto from 'node:crypto';

const CLOUD_WORKER_PROFILE = Object.freeze({
  roles: Object.freeze(['node']),
  scopes: Object.freeze([]),
  purpose: 'cloud-worker'
});

const REQUIRED_BINDING_FIELDS = Object.freeze([
  'repository', 'workflow', 'workflow_ref', 'run_id', 'run_attempt',
  'job_id', 'task_id', 'lease_id', 'attempt', 'input_commit', 'role'
]);

function fail(message, code = 'GATEWAY_ADMISSION_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function nonEmpty(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw fail(`${field} must be a non-empty string`);
  return value.trim();
}

function positiveInt(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw fail(`${field} must be a positive integer`);
  return value;
}

function expiry(value, field) {
  const ms = Date.parse(nonEmpty(value, field));
  if (!Number.isFinite(ms)) throw fail(`${field} must be an ISO date-time`);
  return ms;
}

function bindingKey(binding) {
  return crypto.createHash('sha256').update(JSON.stringify(
    Object.fromEntries(REQUIRED_BINDING_FIELDS.map(field => [field, binding[field]]))
  )).digest('hex');
}

/**
 * Narrow Gateway-side privileged adapter.
 *
 * The supplied provisioner is Gateway-internal authority. It must perform
 * environment creation/enrollment itself; this class never receives or
 * forwards operator.admin credentials to the caller.
 */
export class GatewayRunnerAdmissionService {
  constructor({ provisioner, now = () => Date.now(), maxAdmissionMs = 15 * 60 * 1000 } = {}) {
    if (!provisioner || typeof provisioner.provision !== 'function') {
      throw new TypeError('GatewayRunnerAdmissionService: provisioner.provision is required');
    }
    this.provisioner = provisioner;
    this.now = now;
    this.maxAdmissionMs = maxAdmissionMs;
    this.inflight = new Map();
    this.admissions = new Map();
  }

  async provisionCloudWorkerAdmission({ binding, expiresAt, idempotencyKey }) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw fail('binding is required');
    for (const field of REQUIRED_BINDING_FIELDS) nonEmpty(String(binding[field] ?? ''), field);
    positiveInt(binding.run_attempt, 'run_attempt');
    positiveInt(binding.attempt, 'attempt');
    nonEmpty(binding.role, 'role');
    const expiresAtMs = expiry(expiresAt, 'expiresAt');
    const now = this.now();
    if (expiresAtMs <= now) throw fail('admission is already expired', 'ADMISSION_EXPIRED');
    if (expiresAtMs > now + this.maxAdmissionMs) throw fail('admission expiry exceeds maximum', 'ADMISSION_EXPIRY_TOO_LONG');
    if (binding.role === 'node') throw fail('task role must remain distinct from node bootstrap role', 'ADMISSION_ROLE_CONFLICT');
    const expectedKey = bindingKey(binding);
    if (String(idempotencyKey) !== expectedKey) throw fail('idempotency key does not match binding', 'ADMISSION_IDEMPOTENCY_MISMATCH');

    const existing = this.admissions.get(expectedKey);
    if (existing && existing.expiresAtMs > now) return existing.value;
    const active = this.inflight.get(expectedKey);
    if (active) return active;

    const operation = (async () => {
      const issued = await this.provisioner.provision({
        binding: Object.freeze({ ...binding }),
        expiresAt: new Date(expiresAtMs).toISOString(),
        idempotencyKey: expectedKey,
        requiredBootstrapProfile: CLOUD_WORKER_PROFILE
      });
      if (!issued || typeof issued !== 'object' || Array.isArray(issued)) throw fail('provisioner returned no admission');
      for (const field of ['admission_id', 'environment_id', 'node_setup_id', 'owner_epoch', 'lease_id', 'expires_at', 'bootstrap']) {
        if (issued[field] === undefined || issued[field] === null) throw fail(`provisioner missing ${field}`);
      }
      if (String(issued.lease_id) !== String(binding.lease_id)) throw fail('provisioner lease binding mismatch', 'ADMISSION_BINDING_MISMATCH');
      if (!Number.isSafeInteger(Number(issued.owner_epoch)) || Number(issued.owner_epoch) < 0) throw fail('invalid owner_epoch');
      const issuedExpiryMs = expiry(issued.expires_at, 'issued.expires_at');
      if (issuedExpiryMs <= now || issuedExpiryMs > expiresAtMs) throw fail('provisioner expiry escaped admission fence');
      if (!issued.bootstrap || typeof issued.bootstrap !== 'object' || Array.isArray(issued.bootstrap)) throw fail('invalid bootstrap');
      nonEmpty(issued.bootstrap.target, 'bootstrap.target');
      nonEmpty(issued.bootstrap.credential, 'bootstrap.credential');

      const value = Object.freeze({
        schema_version: 1,
        admission_id: String(issued.admission_id),
        environment_id: String(issued.environment_id),
        node_setup_id: String(issued.node_setup_id),
        owner_epoch: Number(issued.owner_epoch),
        lease_id: String(issued.lease_id),
        expires_at: new Date(issuedExpiryMs).toISOString(),
        bootstrap: Object.freeze({
          target: String(issued.bootstrap.target),
          credential: String(issued.bootstrap.credential)
        })
      });
      this.admissions.set(expectedKey, { expiresAtMs: issuedExpiryMs, value });
      return value;
    })();

    this.inflight.set(expectedKey, operation);
    try {
      return await operation;
    } catch (error) {
      this.admissions.delete(expectedKey);
      throw error;
    } finally {
      this.inflight.delete(expectedKey);
    }
  }
}

export { CLOUD_WORKER_PROFILE };
