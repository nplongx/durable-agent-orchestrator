import crypto from 'node:crypto';

const DEFAULT_ISSUER = 'https://token.actions.githubusercontent.com';
const DEFAULT_MAX_ADMISSION_MS = 15 * 60 * 1000;
const DEFAULT_MAX_BODY_BYTES = 32 * 1024;

function fail(message, status = 400, code = 'INVALID_REQUEST') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw fail(`${field} must be a non-empty string`);
  return value.trim();
}

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw fail(`${field} must be an integer >= 1`);
  return value;
}

function isoMs(value, field) {
  const ms = Date.parse(requiredString(value, field));
  if (!Number.isFinite(ms)) throw fail(`${field} must be an ISO date-time`);
  return ms;
}

function same(a, b, field) {
  if (String(a) !== String(b)) throw fail(`${field} mismatch`, 403, 'ADMISSION_BINDING_MISMATCH');
}

function base64urlDecode(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value).length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}

function decodeJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw fail('invalid JWT structure', 401, 'OIDC_INVALID');
  let header;
  let payload;
  try {
    header = JSON.parse(base64urlDecode(parts[0]).toString('utf8'));
    payload = JSON.parse(base64urlDecode(parts[1]).toString('utf8'));
  } catch {
    throw fail('invalid JWT encoding', 401, 'OIDC_INVALID');
  }
  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: base64urlDecode(parts[2]) };
}

export class GitHubOidcVerifier {
  constructor({
    issuer = DEFAULT_ISSUER,
    audience,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    clockSkewMs = 30_000,
    jwksCacheMs = 5 * 60 * 1000
  } = {}) {
    this.issuer = issuer.replace(/\/$/, '');
    this.audience = requiredString(audience, 'audience');
    this.fetch = fetchImpl;
    this.now = now;
    this.clockSkewMs = clockSkewMs;
    this.jwksCacheMs = jwksCacheMs;
    this.discovery = null;
    this.jwks = null;
    this.jwksExpiresAt = 0;
  }

  async _getDiscovery() {
    if (this.discovery) return this.discovery;
    const response = await this.fetch(`${this.issuer}/.well-known/openid-configuration`);
    if (!response.ok) throw fail('OIDC discovery unavailable', 503, 'OIDC_UNAVAILABLE');
    const data = await response.json();
    if (data.issuer !== this.issuer || !data.jwks_uri) throw fail('invalid OIDC discovery document', 503, 'OIDC_INVALID_PROVIDER');
    this.discovery = data;
    return data;
  }

  async _getJwks() {
    if (this.jwks && this.jwksExpiresAt > this.now()) return this.jwks;
    const discovery = await this._getDiscovery();
    const response = await this.fetch(discovery.jwks_uri);
    if (!response.ok) throw fail('OIDC JWKS unavailable', 503, 'OIDC_UNAVAILABLE');
    const data = await response.json();
    if (!Array.isArray(data.keys) || !data.keys.length) throw fail('OIDC JWKS has no keys', 503, 'OIDC_INVALID_PROVIDER');
    this.jwks = data.keys;
    this.jwksExpiresAt = this.now() + this.jwksCacheMs;
    return this.jwks;
  }

  async verify(token) {
    const { header, payload, signingInput, signature } = decodeJwt(token);
    if (header.alg !== 'RS256' || !header.kid) throw fail('unsupported OIDC JWT algorithm', 401, 'OIDC_INVALID');
    if (payload.iss !== this.issuer) throw fail('OIDC issuer mismatch', 401, 'OIDC_INVALID');
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(this.audience)) throw fail('OIDC audience mismatch', 401, 'OIDC_INVALID');
    const nowSec = Math.floor(this.now() / 1000);
    if (!Number.isFinite(payload.exp) || payload.exp <= nowSec - this.clockSkewMs / 1000) throw fail('OIDC token expired', 401, 'OIDC_EXPIRED');
    if (payload.nbf !== undefined && payload.nbf > nowSec + this.clockSkewMs / 1000) throw fail('OIDC token not active', 401, 'OIDC_NOT_ACTIVE');
    if (payload.iat !== undefined && payload.iat > nowSec + this.clockSkewMs / 1000) throw fail('OIDC token issued in the future', 401, 'OIDC_INVALID');
    const keys = await this._getJwks();
    let jwk = keys.find(key => key.kid === header.kid && key.kty === 'RSA' && key.alg === 'RS256');
    if (!jwk) {
      this.jwksExpiresAt = 0;
      jwk = (await this._getJwks()).find(key => key.kid === header.kid && key.kty === 'RSA' && key.alg === 'RS256');
    }
    if (!jwk) throw fail('OIDC signing key not found', 401, 'OIDC_INVALID');
    let verified = false;
    try {
      const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
      verified = crypto.verify('RSA-SHA256', Buffer.from(signingInput), key, signature);
    } catch {
      verified = false;
    }
    if (!verified) throw fail('OIDC signature invalid', 401, 'OIDC_INVALID');
    for (const claim of ['repository', 'workflow', 'workflow_ref', 'run_id', 'run_attempt']) {
      requiredString(payload[claim], `OIDC ${claim}`);
    }
    return Object.freeze(payload);
  }
}

export class RunnerAdmissionBroker {
  constructor({
    oidcVerifier,
    gateway,
    authorizeBinding,
    repository,
    workflow,
    workflowRef,
    audience,
    now = () => Date.now(),
    maxAdmissionMs = DEFAULT_MAX_ADMISSION_MS,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES
  } = {}) {
    if (!oidcVerifier) throw new TypeError('RunnerAdmissionBroker: oidcVerifier is required');
    if (!gateway || typeof gateway.provisionCloudWorkerAdmission !== 'function') {
      throw new TypeError('RunnerAdmissionBroker: gateway.provisionCloudWorkerAdmission is required');
    }
    if (typeof authorizeBinding !== 'function') throw new TypeError('RunnerAdmissionBroker: authorizeBinding is required');
    this.oidcVerifier = oidcVerifier;
    this.gateway = gateway;
    this.authorizeBinding = authorizeBinding;
    this.repository = requiredString(repository, 'repository');
    this.workflow = requiredString(workflow, 'workflow');
    this.workflowRef = requiredString(workflowRef, 'workflowRef');
    this.audience = requiredString(audience, 'audience');
    this.now = now;
    this.maxAdmissionMs = maxAdmissionMs;
    this.maxBodyBytes = maxBodyBytes;
    this.replay = new Map();
    this.jtiBindings = new Map();
    this.inflight = new Map();
  }

  _requestBody(request) {
    const allowed = new Set([
      'repository', 'workflow', 'workflow_ref', 'run_id', 'run_attempt',
      'job_id', 'task_id', 'lease_id', 'attempt', 'input_commit', 'role', 'expires_at'
    ]);
    for (const key of Object.keys(request)) if (!allowed.has(key)) throw fail(`unsupported field ${key}`);
    requiredString(request.repository, 'repository');
    requiredString(request.workflow, 'workflow');
    requiredString(request.workflow_ref, 'workflow_ref');
    requiredString(request.run_id, 'run_id');
    positiveInteger(request.run_attempt, 'run_attempt');
    requiredString(request.job_id, 'job_id');
    requiredString(request.task_id, 'task_id');
    requiredString(request.lease_id, 'lease_id');
    positiveInteger(request.attempt, 'attempt');
    requiredString(request.input_commit, 'input_commit');
    requiredString(request.role, 'role');
    const expiresAtMs = isoMs(request.expires_at, 'expires_at');
    return { ...request, expiresAtMs };
  }

  async admit({ token, request }) {
    if (typeof token !== 'string' || !token.trim()) throw fail('Bearer OIDC token is required', 401, 'OIDC_REQUIRED');
    const claims = await this.oidcVerifier.verify(token);
    const body = this._requestBody(request);
    same(body.repository, this.repository, 'repository');
    same(body.workflow, this.workflow, 'workflow');
    same(body.workflow_ref, this.workflowRef, 'workflow_ref');
    same(body.repository, claims.repository, 'OIDC repository');
    same(body.workflow, claims.workflow, 'OIDC workflow');
    same(body.workflow_ref, claims.workflow_ref, 'OIDC workflow_ref');
    same(body.run_id, claims.run_id, 'OIDC run_id');
    same(body.run_attempt, Number(claims.run_attempt), 'OIDC run_attempt');

    const now = this.now();
    const tokenExpiry = Number(claims.exp) * 1000;
    if (body.expiresAtMs <= now) throw fail('admission expires in the past', 403, 'ADMISSION_EXPIRED');
    if (body.expiresAtMs > now + this.maxAdmissionMs) throw fail('admission expiry exceeds maximum', 403, 'ADMISSION_EXPIRY_TOO_LONG');
    if (body.expiresAtMs > tokenExpiry) throw fail('admission outlives OIDC token', 403, 'ADMISSION_OUTLIVES_TOKEN');

    const jti = requiredString(claims.jti, 'OIDC jti');
    const idempotencyKey = crypto.createHash('sha256').update(JSON.stringify({
      repository: body.repository, workflow: body.workflow, workflow_ref: body.workflow_ref,
      run_id: body.run_id, run_attempt: body.run_attempt, job_id: body.job_id,
      task_id: body.task_id, lease_id: body.lease_id, attempt: body.attempt,
      input_commit: body.input_commit, role: body.role
    })).digest('hex');
    const priorBinding = this.jtiBindings.get(jti);
    if (priorBinding && priorBinding !== idempotencyKey) {
      throw fail('OIDC token replayed for a different admission binding', 409, 'OIDC_REPLAY');
    }

    const binding = await this.authorizeBinding({
      repository: body.repository,
      workflow: body.workflow,
      workflow_ref: body.workflow_ref,
      run_id: body.run_id,
      run_attempt: body.run_attempt,
      job_id: body.job_id,
      task_id: body.task_id,
      lease_id: body.lease_id,
      attempt: body.attempt,
      input_commit: body.input_commit,
      role: body.role,
      expires_at: new Date(body.expiresAtMs).toISOString(),
      claims
    });
    if (!binding || binding.allowed !== true) throw fail('task/lease binding denied', 403, 'ADMISSION_BINDING_DENIED');

    this.jtiBindings.set(jti, idempotencyKey);
    const replayKey = `${jti}:${idempotencyKey}`;
    const existing = this.replay.get(replayKey);
    if (existing && existing.expiresAtMs > now) return existing.response;
    const inflight = this.inflight.get(replayKey);
    if (inflight) return inflight;

    const provision = (async () => {
      const provisioned = await this.gateway.provisionCloudWorkerAdmission({
        binding: {
          ...binding,
          repository: body.repository,
          workflow: body.workflow,
          workflow_ref: body.workflow_ref,
          run_id: body.run_id,
          run_attempt: body.run_attempt,
          job_id: body.job_id,
          task_id: body.task_id,
          lease_id: body.lease_id,
          attempt: body.attempt,
          input_commit: body.input_commit,
          role: body.role
        },
        expiresAt: new Date(body.expiresAtMs).toISOString(),
        idempotencyKey
      });
      if (!provisioned || typeof provisioned !== 'object') throw fail('Gateway returned no admission', 502, 'GATEWAY_ADMISSION_FAILED');
      for (const field of ['admission_id', 'environment_id', 'node_setup_id', 'owner_epoch', 'lease_id', 'expires_at', 'bootstrap']) {
        if (provisioned[field] === undefined || provisioned[field] === null) throw fail(`Gateway admission missing ${field}`, 502, 'GATEWAY_ADMISSION_INVALID');
      }
      same(provisioned.lease_id, body.lease_id, 'Gateway lease_id');
      if (!Number.isSafeInteger(Number(provisioned.owner_epoch)) || Number(provisioned.owner_epoch) < 0) {
        throw fail('Gateway admission owner_epoch is invalid', 502, 'GATEWAY_ADMISSION_INVALID');
      }
      const gatewayExpiresAtMs = isoMs(provisioned.expires_at, 'Gateway expires_at');
      if (gatewayExpiresAtMs <= now || gatewayExpiresAtMs > body.expiresAtMs || gatewayExpiresAtMs > tokenExpiry) {
        throw fail('Gateway admission expiry is outside the requested fence', 502, 'GATEWAY_ADMISSION_INVALID');
      }
      if (!provisioned.bootstrap || typeof provisioned.bootstrap !== 'object' || Array.isArray(provisioned.bootstrap)) {
        throw fail('Gateway admission bootstrap is invalid', 502, 'GATEWAY_ADMISSION_INVALID');
      }
      requiredString(provisioned.bootstrap.target, 'Gateway bootstrap.target');
      requiredString(provisioned.bootstrap.credential, 'Gateway bootstrap.credential');
      const response = {
        schema_version: 1,
        admission_id: String(provisioned.admission_id),
        environment_id: String(provisioned.environment_id),
        node_setup_id: String(provisioned.node_setup_id),
        owner_epoch: Number(provisioned.owner_epoch),
        lease_id: String(provisioned.lease_id),
        expires_at: new Date(gatewayExpiresAtMs).toISOString(),
        bootstrap: Object.freeze({
          target: String(provisioned.bootstrap.target),
          credential: String(provisioned.bootstrap.credential)
        })
      };
      const safe = Object.freeze(response);
      this.replay.set(replayKey, { expiresAtMs: Math.min(body.expiresAtMs, tokenExpiry), response: safe });
      return safe;
    })();
    this.inflight.set(replayKey, provision);
    try {
      return await provision;
    } catch (error) {
      this.replay.delete(replayKey);
      throw error;
    } finally {
      this.inflight.delete(replayKey);
    }
  }

  async handle(request, response) {
    try {
      const authorization = String(request.headers.authorization || '');
      const match = authorization.match(/^Bearer\s+(.+)$/i);
      if (!match) throw fail('Bearer OIDC token is required', 401, 'OIDC_REQUIRED');
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (Buffer.byteLength(raw, 'utf8') > this.maxBodyBytes) throw fail('request body too large', 413, 'BODY_TOO_LARGE');
      }
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { throw fail('request body must be valid JSON'); }
      const result = await this.admit({ token: match[1], request: body });
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(result));
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: error?.code || 'INTERNAL_ERROR', message: error?.message || 'internal error' }));
    }
  }
}

export function createRunnerAdmissionBroker(options) {
  return new RunnerAdmissionBroker(options);
}
