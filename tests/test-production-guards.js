import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const root = '/home/long/work/chatgpt-adapter';
const testDb = path.join(root, 'data', `test-production-guards-${crypto.randomUUID()}.db`);
const fakeOpenClaw = path.join('/tmp', `fake-openclaw-${crypto.randomUUID()}.mjs`);
process.env.WORKFLOW_DB = testDb;
process.env.WORKFLOW_DATA_DIR = path.dirname(testDb);
process.env.OPENCLAW_BIN = fakeOpenClaw;

await fsPromises.writeFile(fakeOpenClaw, `#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === 'sessions' && args[1] === '--all-agents') {
  process.stdout.write(JSON.stringify({sessions:[{key:process.env.FAKE_OPENCLAW_SESSION,status:'done',runId:'fake-run-1'}]}));
  process.exit(0);
}
if (args[0] === 'sessions' && args[1] === 'export-trajectory') {
  if (process.env.FAKE_OPENCLAW_MODE === 'timeout') await new Promise(() => {});
  const output = args[args.indexOf('--output') + 1];
  const dir = path.join('/tmp','.openclaw','trajectory-exports',output);
  await fs.mkdir(dir,{recursive:true});
  const command = process.env.FAKE_OPENCLAW_COMMAND || 'node --check /home/long/work/chatgpt-adapter/server.js';
  const events = [
    {type:'tool.call',data:{toolCallId:'fake-call',name:'exec',args:{command}}},
    {type:'tool.result',data:{toolCallId:'fake-call',success:true,result:{content:[{type:'text',text:'(no output)'}]},details:{status:'completed',exitCode:0,aggregated:''}}}
  ];
  await fs.writeFile(path.join(dir,'events.jsonl'), events.map(x=>JSON.stringify(x)).join('\\n')+'\\n');
  process.stdout.write(JSON.stringify({outputDir:dir,eventCount:2}));
  process.exit(0);
}
if (args[0] === 'agent') {
  process.stdout.write(JSON.stringify({status:'ok',runId:'fake-run-1',sessionKey:process.env.FAKE_OPENCLAW_SESSION,result:'retry dispatched'}));
  process.exit(0);
}
process.exit(2);
`);
await fsPromises.chmod(fakeOpenClaw, 0o755);

const { WorkflowStore } = await import('../job-store.js');
const { RecoveryManager } = await import('../recovery-manager.js');
const { formatMessagesToPrompt, toolsForSpecialistPrompt } = await import('../server.js');
const store = new WorkflowStore();

const specialistTools = toolsForSpecialistPrompt([
  {type:'function',function:{name:'exec',parameters:{}}},
  {type:'function',function:{name:'read',parameters:{}}}
], 'qa');
assert.deepEqual(specialistTools.map(t => t.function?.name || t.name), ['read']);
const specialistPrompt = formatMessagesToPrompt([
  {role:'system',content:'Runtime: name=QA Engineer | agent=qa'},
  {role:'user',content:'Run immediately: node --check /home/long/work/chatgpt-adapter/test-tool-turn.js'}
], specialistTools, 'chatgpt-free');
assert.equal(specialistPrompt.agentRole,'qa');
assert.match(specialistPrompt.prompt,/Run immediately: node --check \/home\/long\/work\/chatgpt-adapter\/test-tool-turn\.js/);

function makeProductionJob(suffix) {
  const sessionKey = `agent:architect:subagent:test-${crypto.randomUUID()}`;
  const job = store.getOrCreateJob({conversationKey:`guards:${suffix}`,title:`Production E2E guard ${suffix}`});
  store.transition(job.job_id,'PROPOSED');
  store.approve(job.job_id,'test approval');
  const cto = store.dispatch(job.job_id,{role:'cto',description:'Production E2E guard'});
  const child = store.createChildTask(job.job_id,{parentTaskId:cto.task_id,role:'architect',description:'Run exact command: node --check /home/long/work/chatgpt-adapter/server.js'});
  store.attachTaskRuntime(child.task_id,{runId:'fake-run-1',sessionKey});
  return {jobId:job.job_id,ctoTask:cto.task_id,childId:child.task_id,sessionId:store.getSessionByTask(child.task_id).session_id,sessionKey};
}

const slackJob = makeProductionJob('slack');
const slackBefore = store.getSlackProjection(slackJob.jobId);
store.recordEvent(slackJob.jobId,'session.heartbeat',{sessionId:slackJob.sessionId},'heartbeat-test');
store.recordEvent(slackJob.jobId,'session.stale',{sessionId:slackJob.sessionId},'stale-test');
const businessEvent = store.recordEvent(slackJob.jobId,'task.completed',{taskId:slackJob.childId},'business-test');
let projection = store.getSlackProjection(slackJob.jobId);
assert.equal(projection.totalEvents,slackBefore.totalEvents + 1);
assert.equal(projection.pendingEvents,slackBefore.pendingEvents + 1);
assert.ok(store.listUnprojectedEvents(20).some(e=>e.event_id===businessEvent));
store.claimSlackProjection(businessEvent,slackJob.jobId,{messageId:'fake-slack-message'});
projection = store.getSlackProjection(slackJob.jobId);
assert.equal(projection.pendingEvents,slackBefore.pendingEvents);

const staleJob = makeProductionJob('stale-done');
process.env.FAKE_OPENCLAW_SESSION = staleJob.sessionKey;
store.updateAgentSession(staleJob.sessionId,{state:'STALE'});
const beforeTaskCount = store.getJobTrace(staleJob.jobId).tasks.length;
const beforeSessionCount = store.getJobTrace(staleJob.jobId).sessions.length;
const recovery = new RecoveryManager(store,{trajectoryTimeoutMs:2000});
await recovery.reconcile({jobId:staleJob.jobId});
assert.equal(store.getTask(staleJob.childId).status,'completed');
assert.equal(store.getJobTrace(staleJob.jobId).tasks.length,beforeTaskCount);
assert.equal(store.getJobTrace(staleJob.jobId).sessions.length,beforeSessionCount);
assert.equal(store.getSession(staleJob.sessionId).state,'TERMINATED');

const failedJob = makeProductionJob('failed-repair');
process.env.FAKE_OPENCLAW_SESSION = failedJob.sessionKey;
store.db.prepare("UPDATE tasks SET status='failed', updated_at=? WHERE task_id=?").run(new Date().toISOString(),failedJob.childId);
store.db.prepare("UPDATE attempts SET status='failed', finished_at=? WHERE task_id=? AND status='started'").run(new Date().toISOString(),failedJob.childId);
store.db.prepare("INSERT INTO results(result_id,task_id,outcome,content,created_at) VALUES(?,?,?,?,?)").run(`result_${crypto.randomUUID()}`,failedJob.childId,'failure','provider timeout',new Date().toISOString());
store.updateAgentSession(failedJob.sessionId,{state:'FAILED'});
const failedTaskCount = store.getJobTrace(failedJob.jobId).tasks.length;
const failedSessionCount = store.getJobTrace(failedJob.jobId).sessions.length;
process.env.FAKE_OPENCLAW_COMMAND = 'node --check ~/work/chatgpt-adapter/server.js';
await recovery.reconcile({jobId:failedJob.jobId});
assert.equal(store.getTask(failedJob.childId).status,'failed');
process.env.FAKE_OPENCLAW_COMMAND = '';
await recovery.reconcile({jobId:failedJob.jobId});
assert.equal(store.getTask(failedJob.childId).status,'completed');
assert.equal(store.getJobTrace(failedJob.jobId).tasks.length,failedTaskCount);
assert.equal(store.getJobTrace(failedJob.jobId).sessions.length,failedSessionCount);
const repaired = store.db.prepare('SELECT outcome,content FROM results WHERE task_id=? ORDER BY created_at DESC LIMIT 1').get(failedJob.childId);
assert.equal(repaired.outcome,'success');
assert.match(repaired.content,/\[ACTUAL TOOL RESULT EVIDENCE\]/i);
assert.match(repaired.content,/node --check \/home\/long\/work\/chatgpt-adapter\/server\.js/);
assert.match(repaired.content,/exit status\/code: 0/);

assert.equal(typeof recovery.retryAgentTask, 'undefined', 'RecoveryManager must not own business retry/orchestration');

const timeoutJob = makeProductionJob('trajectory-timeout');
process.env.FAKE_OPENCLAW_SESSION = timeoutJob.sessionKey;
store.updateAgentSession(timeoutJob.sessionId,{state:'STALE'});
process.env.FAKE_OPENCLAW_MODE = 'timeout';
const timeoutRecovery = new RecoveryManager(store,{trajectoryTimeoutMs:100});
await timeoutRecovery.reconcile({jobId:timeoutJob.jobId});
assert.equal(store.getTask(timeoutJob.childId).status,'running');
assert.equal(store.getSession(timeoutJob.sessionId).state,'STALE');

await fsPromises.rm(testDb,{force:true});
await fsPromises.rm(`${testDb}-wal`,{force:true});
await fsPromises.rm(`${testDb}-shm`,{force:true});
await fsPromises.rm(fakeOpenClaw,{force:true});
console.log('test-production-guards: PASS');
