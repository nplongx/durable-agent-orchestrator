#!/usr/bin/env node
// Offline policy enforcement tests. No plugin, model, or benchmark scenario is launched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertV3ToolAllowed, V3_POLICY_TOOL_GROUPS } from './v3-tool-policy.mjs';
import { createBasicToolExecutor } from './scenario-basic-tools.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(fs.readFileSync(path.join(here, 'scenario-execution-spec-v3-draft.json'), 'utf8'));
const c = id => spec.cases.find(item => item.case_id === id);
const denied = (scenario, names) => { for (const name of names) assert.throws(() => assertV3ToolAllowed(scenario, name), /denied|hard safety deny/, `${scenario.case_id} should deny ${name}`); };
const allowed = (scenario, names) => { for (const name of names) assert.equal(assertV3ToolAllowed(scenario, name), true, `${scenario.case_id} should allow ${name}`); };
assert.deepEqual(new Set(V3_POLICY_TOOL_GROUPS.proposal), new Set(['workflow_create']));
allowed(c('CASE-06'), ['workflow_create','workflow_get','workflow_events','workflow_artifacts']);
denied(c('CASE-06'), ['workflow_approve','custom_workflow_approve','workflow_dispatch','custom_role_create','custom_workflow_create','custom_workflow_preview','custom_workflow_run_create','workflow_prepare_tasks','workflow_next_task','workflow_complete_task','workflow_complete_synthesis','task_execute_local','workflow_e2e_run','workflow_record_intervention','write_file','delete_file']);
for (const id of ['CASE-09','CASE-10']) denied(c(id), ['workflow_create','workflow_approve','workflow_dispatch','custom_workflow_create','workflow_prepare_tasks','workflow_record_intervention','write_file','delete_file']);
for (const id of ['CASE-03','CASE-05']) {
  denied(c(id), ['write_file','delete_file']);
  allowed(c(id), ['workflow_approve','workflow_dispatch','workflow_prepare_tasks']);
}
allowed(c('CASE-01'), ['workflow_create','workflow_approve','workflow_dispatch','workflow_prepare_tasks','write_file']);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phase2-v3-case07-path-'));
try {
  fs.writeFileSync(path.join(root,'original.txt'),'immutable\n',{mode:0o600});
  fs.mkdirSync(path.join(root,'sandbox-copy'));
  fs.writeFileSync(path.join(root,'sandbox-copy','original.txt'),'copy\n',{mode:0o600});
  const executor = createBasicToolExecutor({workspace:root,scenario:c('CASE-07')});
  await assert.rejects(executor.execute('write_file',{path:'original.txt',content:'tampered\n'}),/immutable path/);
  await assert.rejects(executor.execute('write_file',{path:'outside.txt',content:'no\n'}),/exact path allowlist/);
  await assert.rejects(executor.execute('delete_file',{path:'original.txt'}),/immutable path/);
  const result = await executor.execute('write_file',{path:'sandbox-copy/original.txt',content:'allowed copy\n'});
  assert.equal(result.written,true);
  assert.equal(fs.readFileSync(path.join(root,'original.txt'),'utf8'),'immutable\n');
  assert.equal(fs.readFileSync(path.join(root,'sandbox-copy','original.txt'),'utf8'),'allowed copy\n');
} finally { fs.rmSync(root,{recursive:true,force:true}); }
console.log('PASS: v3 runtime policy denies forbidden proposal/execution/approval/dispatch/intervention/workspace mutations');
console.log('PASS: CASE-06 remains proposal-only; CASE-09/10 are read-only; CASE-03/05 deny file writes while permitting their approved workflow tools');
console.log('PASS: CASE-07 permits mutation only at the exact copy path and preserves immutable original bytes');
