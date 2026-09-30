import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = fs.mkdtempSync('/tmp/m9-governance-');
process.env.WORKFLOW_DB = path.join(dir, 'workflow.db');
process.env.WORKFLOW_DATA_DIR = dir;

const { getAgentContract } = await import('../src/runtime/workflow/agent-contracts.js');
const { assertAgentPermission } = await import('../src/runtime/workflow/governance.js');
const { WorkflowStore } = await import('../src/runtime/job-store.js');

assertAgentPermission('engineer', 'workspace.write');
assertAgentPermission('engineer', 'execution.request');
assert.throws(() => assertAgentPermission('reviewer', 'workspace.write'), /Agent permission denied/);
assert.throws(() => assertAgentPermission('qa', 'workspace.write'), /Agent permission denied/);
assert.equal(getAgentContract('product-owner').id, 'agent.product-owner');

const store = new WorkflowStore();
const job = store.getOrCreateJob({ conversationKey: `m9-${crypto.randomUUID()}`, title: 'M9 governance' });
store.transition(job.job_id, 'EXECUTING');
const cto = store.dispatch(job.job_id, { role: 'cto', description: 'M9 governance session' });
store.attachOpenClawRun(job.job_id, { runId: 'm9-run', sessionKey: 'agent:cto:m9' });
const session = store.getSessionByTask(store.getJob(job.job_id).active_task_id);

store.grantSessionAccess(session.session_id, { accessorRole: 'architect', permission: 'OBSERVE', grantedBy: 'cto' });
assert.throws(() => store.grantSessionAccess(session.session_id, { accessorRole: 'qa', permission: 'TAKEOVER', grantedBy: 'architect' }), /Session grant denied/);
assert.throws(() => store.revokeSessionAccess(store.listSessionAccess(session.session_id)[0].access_id, { actor: 'qa' }), /Session revoke denied/);
assert.equal(store.hasSessionPermission(session.session_id, 'architect', 'OBSERVE'), true);

console.log('M9 GOVERNANCE PASS');
