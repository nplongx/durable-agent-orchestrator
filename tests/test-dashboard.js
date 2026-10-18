import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDashboardServer } from '../dashboard/server.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-dashboard-test-'));
const dataDir = path.join(temp, 'data');
const dbPath = path.join(dataDir, 'workflow.db');
fs.mkdirSync(path.join(dataDir, 'runtime'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'case01-snapshots'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'runtime', 'runner.log'), `hello from local runtime\napi_key=fixture-super-secret-token-123456\n${'x'.repeat(70_000)}`);
fs.writeFileSync(path.join(dataDir, 'runtime', 'unsafe.bin'), Buffer.from([0,1,2,3]));
fs.writeFileSync(path.join(dataDir, 'private.txt'), 'must not be exposed through outside symlink');
try { fs.symlinkSync(path.join(dataDir, 'private.txt'), path.join(dataDir, 'runtime', 'linked.txt')); } catch {}

const db = new DatabaseSync(dbPath);
db.exec(`
CREATE TABLE jobs(job_id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, status TEXT NOT NULL, active_task_id TEXT, provider_waiting INTEGER DEFAULT 0, provider_retry_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, approved_at TEXT, completed_at TEXT);
CREATE TABLE workflow_runtime_state(job_id TEXT PRIMARY KEY, phase TEXT, attempt INTEGER, resume_after TEXT, last_error TEXT, updated_at TEXT);
CREATE TABLE tasks(task_id TEXT PRIMARY KEY,job_id TEXT NOT NULL,role TEXT NOT NULL,description TEXT,status TEXT,openclaw_run_id TEXT,openclaw_session_key TEXT,parent_task_id TEXT,dependency_json TEXT,metadata_json TEXT,created_at TEXT,updated_at TEXT,execution_session_id TEXT,execution_status TEXT,execution_attempt INTEGER,execution_pid INTEGER,execution_exit_code INTEGER,execution_started_at TEXT,execution_finished_at TEXT,execution_stdout TEXT,execution_stderr TEXT);
CREATE TABLE approvals(approval_id TEXT PRIMARY KEY,job_id TEXT,decision TEXT,actor TEXT,raw_text TEXT,proposal_hash TEXT,created_at TEXT);
CREATE TABLE attempts(attempt_id TEXT PRIMARY KEY,task_id TEXT,status TEXT,openclaw_run_id TEXT,started_at TEXT,finished_at TEXT,error TEXT);
CREATE TABLE results(result_id TEXT PRIMARY KEY,task_id TEXT,outcome TEXT,content TEXT,created_at TEXT);
CREATE TABLE artifacts(artifact_id TEXT PRIMARY KEY,job_id TEXT,task_id TEXT,kind TEXT,uri TEXT,metadata_json TEXT,created_at TEXT,schema_version INTEGER,producer_role TEXT,content TEXT,evidence_json TEXT,status TEXT,supersedes TEXT,content_hash TEXT);
CREATE TABLE reports(report_id TEXT PRIMARY KEY,job_id TEXT,kind TEXT,content TEXT,delivered_at TEXT,created_at TEXT);
CREATE TABLE events(event_id TEXT PRIMARY KEY,job_id TEXT,type TEXT,payload_json TEXT,created_at TEXT);
CREATE TABLE workflow_events(workflow_event_id TEXT PRIMARY KEY,job_id TEXT,from_phase TEXT,to_phase TEXT,event TEXT,attempt INTEGER,payload_json TEXT,created_at TEXT);
CREATE TABLE execution_batches(batch_id TEXT PRIMARY KEY,job_id TEXT,parent_task_id TEXT,role TEXT,status TEXT,attempt INTEGER,created_at TEXT,started_at TEXT,finished_at TEXT,aggregate_content TEXT);
CREATE TABLE execution_batch_items(batch_id TEXT,item_id TEXT,task_id TEXT,command TEXT,cwd TEXT,timeout_ms INTEGER,attempt INTEGER,status TEXT,execution_session_id TEXT,execution_pid INTEGER,exit_code INTEGER,stdout TEXT,stderr TEXT,started_at TEXT,finished_at TEXT,error TEXT,PRIMARY KEY(batch_id,item_id));
CREATE TABLE custom_role_versions(role_id TEXT,version INTEGER,name TEXT,description TEXT,system_prompt TEXT,input_contract_json TEXT,output_artifact_type TEXT,allowed_capabilities_json TEXT,permissions_json TEXT,allowed_tools_json TEXT,skills_json TEXT,created_at TEXT,created_by TEXT,PRIMARY KEY(role_id,version));
CREATE TABLE custom_workflow_versions(workflow_id TEXT,version INTEGER,name TEXT,description TEXT,input_contract_json TEXT,tasks_json TEXT,created_at TEXT,created_by TEXT,PRIMARY KEY(workflow_id,version));
`);
const now = new Date().toISOString();
const insertJob = db.prepare('INSERT INTO jobs(job_id,conversation_key,title,state,status,active_task_id,created_at,updated_at,approved_at) VALUES(?,?,?,?,?,?,?,?,?)');
insertJob.run('job-demo-001','test:demo','Dashboard smoke test','EXECUTING','active','task-demo-001',now,now,now);
insertJob.run('job-demo-002','test:failed','Failed test workflow','FAILED','failed',null,now,now,null);
db.prepare('INSERT INTO workflow_runtime_state VALUES(?,?,?,?,?,?)').run('job-demo-001','RUN_CHILDREN',2,null,null,now);
db.prepare('INSERT INTO workflow_runtime_state VALUES(?,?,?,?,?,?)').run('job-demo-002','FAILED',1,null,'fixture error',now);
db.prepare('INSERT INTO tasks(task_id,job_id,role,description,status,dependency_json,metadata_json,created_at,updated_at,execution_status,execution_exit_code,execution_stdout,execution_stderr) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('task-demo-001','job-demo-001','engineer','Produce local dashboard','completed','[]','{}',now,now,'completed',0,'hello stdout','');
db.prepare('INSERT INTO tasks(task_id,job_id,role,description,status,dependency_json,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('task-demo-002','job-demo-001','qa','Verify local dashboard','running','["task-demo-001"]','{}',now,now);
db.prepare('UPDATE tasks SET execution_session_id=?,execution_status=?,execution_attempt=?,execution_exit_code=?,execution_started_at=?,execution_finished_at=?,execution_stdout=?,execution_stderr=? WHERE task_id=?').run('exec-fixture-failed','failed',1,1,now,now,'','fixture execution failed safely','task-demo-002');
const oversizedTaskMetadata = JSON.stringify({workflow_plan_task_id:'analyze-large-metadata',custom_role_id:'fixture-analyst',custom_role_version:1,custom_role_name:'Fixture Evidence Analyst',custom_role_skills:[{name:'oversized-skill',source:{kind:'local',location:'/home/red-team/private-skill'},files:[{path:'C:\\Users\\red-team\\private\\skill.txt',sha256:'d'.repeat(64)},{path:'\\\\red-team\\share\\private.md',sha256:'e'.repeat(64)}]}],padding:'oversized metadata padding '.repeat(300)});
assert.ok(oversizedTaskMetadata.length > 4_000);
db.prepare('INSERT INTO tasks(task_id,job_id,role,description,status,dependency_json,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('task-demo-003','job-demo-001','custom-task-2','Inspect oversized metadata safely','completed','[]',oversizedTaskMetadata,now,now);
db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?,?,?)').run('approval-demo','job-demo-001','approved','test-user','approved exact plan','a'.repeat(64),now);
db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?,?)').run('attempt-demo','task-demo-001','completed',null,now,now,null);
db.prepare('INSERT INTO results VALUES(?,?,?,?,?)').run('result-demo','task-demo-001','success',('real result content '.repeat(20)+'source path /home/red-team/private-skill/references/private.md ').repeat(25),now);
db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('artifact-demo','job-demo-001','task-demo-001','research','local://artifact','{"labels":["test"]}',now,1,'custom-task-1',JSON.stringify({summary:'fixture artifact',details:'z'.repeat(50_000),api_key:'fixture-artifact-secret-456789'}),'["result-demo"]','active',null,'b'.repeat(64));
db.prepare('INSERT INTO reports VALUES(?,?,?,?,?,?)').run('report-demo','job-demo-001','summary','report content',now,now);
db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run('event-demo','job-demo-001','task.completed',JSON.stringify({task_id:'task-demo-001',note:'safe payload'}),now);
db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run('event-large','job-demo-001','output.large',JSON.stringify({payload:'y'.repeat(20_000)}),now);
db.prepare('INSERT INTO workflow_events VALUES(?,?,?,?,?,?,?,?)').run('workflow-event-demo','job-demo-001','APPROVED','RUN_CHILDREN','workflow.dispatched',1,'{"source":"fixture"}',now);
db.prepare('INSERT INTO execution_batches VALUES(?,?,?,?,?,?,?,?,?,?)').run('batch-demo','job-demo-001','task-demo-001','engineer','COMPLETED',1,now,now,now,'aggregate output');
db.prepare('INSERT INTO execution_batch_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('batch-demo','item-1','task-demo-001','node build.js',dataDir,5000,1,'COMPLETED',null,null,0,'stdout body','stderr body',now,now,null);
const skillSnapshot = [{name:'review-evidence',description:'Check claims against stored evidence.',source:{kind:'local',location:'/home/test-user/.agents/skills/review-evidence'},sha256:'a'.repeat(64),instructions:'Compare every conclusion against primary source evidence. Record unresolved gaps instead of guessing. '+'x'.repeat(1_700),files:[{path:'references/checklist.md',content:'fixture checklist',sha256:'b'.repeat(64),size_bytes:17},{path:'/home/test-user/.agents/skills/review-evidence/private.md',sha256:'c'.repeat(64),size_bytes:21},{path:'C:\\Users\\fixture\\AppData\\private.txt',sha256:'d'.repeat(64),size_bytes:22},{path:'\\\\server\\share\\private.md',sha256:'e'.repeat(64),size_bytes:23}]}];
db.prepare('INSERT INTO custom_role_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('fixture-analyst',1,'Fixture Evidence Analyst','Produces grounded findings from upstream artifacts.','Act as evidence analyst.',JSON.stringify(['job.request','research']),'research',JSON.stringify(['research.collect']),JSON.stringify(['workspace.read','artifact.create']),JSON.stringify(['workflow_get','workflow_artifacts']),JSON.stringify(skillSnapshot),now,'fixture-user');
db.prepare('INSERT INTO custom_role_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('fixture-analyst',2,'Fixture Evidence Analyst','Version 2 with no attached skill.','Act as evidence analyst; version 2.',JSON.stringify(['job.request','research']),'research',JSON.stringify(['research.collect']),JSON.stringify(['workspace.read','artifact.create']),JSON.stringify(['workflow_get','workflow_artifacts']),JSON.stringify([]),now,'fixture-user');
db.prepare('INSERT INTO custom_workflow_versions VALUES(?,?,?,?,?,?,?,?)').run('fixture-review-pipeline',1,'Fixture Review Pipeline','Three-stage review using a pinned custom profile.',JSON.stringify(['job.request']),JSON.stringify([{id:'analyze-evidence',role_id:'fixture-analyst',role_version:1,input_contract:['job.request'],output_artifact_type:'research',depends_on:[]}]),now,'fixture-user');
db.prepare('UPDATE tasks SET role=?,metadata_json=? WHERE task_id=?').run('custom-task-1',JSON.stringify({workflow_plan_task_id:'analyze-evidence',custom_role_id:'fixture-analyst',custom_role_version:1,custom_role_name:'Fixture Evidence Analyst',custom_role_skills:skillSnapshot}), 'task-demo-001');
db.close();

const app = createDashboardServer({host:'127.0.0.1',port:0,dataDir,dbPath});
let base = '';
try {
  const address = await app.listen();
  base = `http://127.0.0.1:${address.port}`;
  async function get(route, headers = {}) {
    const res = await fetch(`${base}${route}`, {headers});
    const contentType = res.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await res.json() : await res.text();
    return {res,body};
  }
  async function rawGet(route, headers = {}) {
    return new Promise((resolve,reject)=>{
      const req=http.request({hostname:'127.0.0.1',port:address.port,path:route,headers},res=>{
        let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({res:{status:res.statusCode,headers:res.headers},body:JSON.parse(body)}));
      });req.on('error',reject);req.end();
    });
  }

  // Health, real counts and read-only data access.
  let result = await get('/api/health');
  assert.equal(result.res.status,200); assert.equal(result.body.status,'ok'); assert.equal(result.body.read_only,true);
  result = await get('/api/overview');
  assert.equal(result.res.status,200); assert.equal(result.body.counts.jobs,2); assert.equal(result.body.counts.tasks,3); assert.equal(result.body.counts.events,2); assert.equal(result.body.counts.custom_profiles,1); assert.equal(result.body.counts.role_versions,2); assert.equal(result.body.counts.custom_workflows,1); assert.equal(result.body.counts.individual_executions,2);
  assert.equal(result.body.job_statuses.find(x=>x.status==='active').count,1);

  // The role registry exposes durable custom profiles, skill snapshots and exact workflow role-version pins without enabling writes.
  result = await get('/api/roles'); assert.equal(result.res.status,200);
  assert.equal(result.body.summary.custom_profiles,1); assert.equal(result.body.summary.custom_role_versions,2);
  assert.equal(result.body.custom_roles.length,1); assert.equal(result.body.custom_roles[0].role_id,'fixture-analyst');
  assert.equal(result.body.custom_roles[0].version,2); assert.equal(result.body.custom_roles[0].skills.length,0,'latest version exposes its own skill state, not a prior version');
  result = await get('/api/roles?versions=all'); assert.equal(result.body.custom_roles.length,2);
  const roleV1=result.body.custom_roles.find(role=>role.version===1);
  assert.equal(roleV1.skills[0].name,'review-evidence'); assert.equal(roleV1.skills[0].instruction_chars>20,true); assert.equal(roleV1.skills[0].instructions_preview.length,1200); assert.equal(roleV1.skills[0].instructions_truncated,true);
  assert.match(roleV1.skills[0].instructions_preview,/primary source evidence/);
  assert.equal(roleV1.skills[0].files[0].path,'references/checklist.md');
  assert.equal(roleV1.skills[0].files[1].path,'private.md');
  assert.equal(roleV1.skills[0].source.includes('/home/test-user'),false,'skill registry must not reveal local absolute paths');
  assert.equal(JSON.stringify(roleV1.skills).includes('/home/test-user'),false,'absolute paths in source metadata and supporting-file names must be redacted');
  assert.equal(result.body.custom_workflows[0].tasks[0].role_id,'fixture-analyst');
  assert.equal(result.body.custom_workflows[0].tasks[0].role_version,1,'workflow pin must remain on exact immutable role version');
  assert.deepEqual(result.body.custom_workflows[0].tasks[0].skills,['review-evidence']);
  result = await get('/api/roles?versions=all&q=review-evidence'); assert.equal(result.body.custom_roles.length,1,'all-version role search must match attached skill names');

  // Batch history reads the durable batch ledger, not specialist task counts.
  result = await get('/api/batches'); assert.equal(result.res.status,200);
  assert.equal(result.body.total,1); assert.equal(result.body.summary.batches,1); assert.equal(result.body.summary.items,1);
  assert.equal(result.body.items[0].batch_id,'batch-demo'); assert.equal(result.body.items[0].items[0].stdout,'stdout body');
  assert.equal(result.body.individual_total,2); assert.equal(result.body.summary.individual_executions,2);
  assert.ok(result.body.individual_items.some(item=>item.task_id==='task-demo-001'&&item.execution_status==='completed'));
  assert.ok(result.body.individual_items.some(item=>item.task_id==='task-demo-002'&&item.execution_status==='failed'));
  assert.equal(result.body.individual_items.some(item=>item.stdout==='hello stdout'&&item.stdout_truncated===false),true);
  assert.match(result.body.empty_explanation,/specialist workflow tasks/);
  result = await get('/api/batches?status=FAILED'); assert.equal(result.body.total,0);
  assert.equal(result.body.individual_total,1,'status filtering must apply independently to individual task runs');
  result = await get('/api/batches?q=batch-demo'); assert.equal(result.body.total,1);
  result = await get('/api/batches?q=Fixture Evidence Analyst'); assert.equal(result.body.individual_total,1,'individual-run search includes the pinned custom role display name');
  result = await get('/api/batches?executionLimit=1&executionOffset=1'); assert.equal(result.body.individual_total,2); assert.equal(result.body.individual_items.length,1,'individual execution pagination must work independently of batch pagination');
  result = await get('/api/batches?limit=100&executionLimit=100'); assert.equal(result.body.limit,10); assert.equal(result.body.individual_limit,50,'execution response limits must be clamped to bounded payload sizes');
  result = await get('/api/roles?q=fixture-review-pipeline'); assert.equal(result.body.custom_roles.length,0); assert.equal(result.body.custom_workflows.length,1,'workflow search exposes only the matching workflow pin set');

  // Search/filter and bounded pagination.
  result = await get('/api/jobs?q=smoke'); assert.equal(result.body.total,1); assert.equal(result.body.items[0].job_id,'job-demo-001');
  result = await get('/api/jobs?status=failed&limit=9999'); assert.equal(result.body.total,1); assert.equal(result.body.limit,200);
  result = await get('/api/jobs?phase=RUN_CHILDREN'); assert.equal(result.body.total,1);

  // Job details include actual task, approval, attempt, result, artifact, event, report and execution evidence.
  result = await get('/api/jobs/job-demo-001'); assert.equal(result.res.status,200);
  assert.equal(result.body.tasks.length,3); assert.equal(result.body.approvals[0].decision,'approved');
  const parsedMetaTask=result.body.tasks.find(x=>x.task_id==='task-demo-001');
  assert.equal(parsedMetaTask.role,'custom-task-1'); assert.equal(parsedMetaTask.role_display,'Fixture Evidence Analyst (fixture-analyst@1)'); assert.equal(parsedMetaTask.metadata_truncated,false); assert.equal(parsedMetaTask.metadata_malformed,false); assert.equal(parsedMetaTask.metadata_available,true);
  assert.equal(parsedMetaTask.metadata.workflow_plan_task_id,'analyze-evidence');
  assert.equal(parsedMetaTask.metadata.custom_role_skills[0].source.label,'Local skill · review-evidence');
  assert.equal(parsedMetaTask.metadata.custom_role_skills[0].files[0].path,'references/checklist.md','safe relative paths remain readable');
  assert.equal(parsedMetaTask.metadata.custom_role_skills[0].files[1].path,'private.md');
  assert.equal(parsedMetaTask.metadata.custom_role_skills[0].files[2].path,'private.txt');
  assert.equal(parsedMetaTask.metadata.custom_role_skills[0].files[3].path,'private.md');
  const oversizedMetaTask=result.body.tasks.find(x=>x.task_id==='task-demo-003');
  assert.equal(oversizedMetaTask.metadata_truncated,true); assert.equal(oversizedMetaTask.metadata_malformed,false); assert.equal(oversizedMetaTask.metadata_available,false);
  assert.equal(oversizedMetaTask.metadata.custom_role_id,'fixture-analyst'); assert.equal(oversizedMetaTask.metadata.custom_role_version,1); assert.equal(oversizedMetaTask.metadata.workflow_plan_task_id,'analyze-large-metadata');
  assert.equal(Object.hasOwn(oversizedMetaTask.metadata,'custom_role_skills'),false,'oversized metadata must not leak the raw/truncated skill object');
  const serializedJobDetails=JSON.stringify(result.body);
  for(const secretPath of ['/home/test-user/.agents/skills/review-evidence','/home/test-user/.agents/skills/review-evidence/private.md','C:\\Users\\fixture\\AppData\\private.txt','\\\\server\\share\\private.md','/home/red-team/private-skill','C:\\Users\\red-team\\private\\skill.txt','\\\\red-team\\share\\private.md']) assert.equal(serializedJobDetails.includes(secretPath),false,`job detail response must not expose ${secretPath}`);
  assert.equal(result.body.artifacts[0].producer_role,'Fixture Evidence Analyst (fixture-analyst@1)');
  assert.equal(result.body.attempts[0].attempt_id,'attempt-demo'); assert.match(result.body.results[0].content,/real result content/);
  assert.equal(result.body.artifacts[0].content_length,JSON.stringify({summary:'fixture artifact',details:'z'.repeat(50_000),api_key:'fixture-artifact-secret-456789'}).length);
  assert.equal(result.body.artifacts[0].content_truncated,true); assert.equal(result.body.events.length,2);
  assert.equal(result.body.transitions.length,1); assert.equal(result.body.batches[0].items[0].exit_code,0);
  assert.equal(result.body.batches[0].items[0].stdout,'stdout body');
  result = await get('/api/jobs/missing-job'); assert.equal(result.res.status,404);

  // Global event and artifact inspection keep returned content bounded.
  result = await get('/api/events?type=output.large'); assert.equal(result.body.total,1); assert.equal(result.body.items[0].payload_truncated,true);
  result = await get('/api/events?type=workflow.dispatched'); assert.equal(result.body.total,1); assert.equal(result.body.items[0].source,'workflow'); assert.equal(result.body.items[0].from_phase,'APPROVED');
  result = await get('/api/artifacts?type=research'); assert.equal(result.body.items.length,1); assert.equal(result.body.items[0].producer_role,'Fixture Evidence Analyst (fixture-analyst@1)'); assert.equal(result.body.items[0].content_length>48_000,true);
  result = await get('/api/artifacts/artifact-demo'); assert.equal(result.res.status,200); assert.equal(result.body.content_truncated,true); assert.equal(JSON.stringify(result.body).length<60_000,true); assert.equal(JSON.stringify(result.body).includes('fixture-artifact-secret-456789'),false);

  // Text file browsing is confined and bounded; the DB, binaries and symlinks are not exposed.
  result = await get('/api/files'); assert.equal(result.res.status,200);
  assert.equal(result.body.entries.some(x=>x.name==='workflow.db'),false);
  assert.equal(result.body.entries.some(x=>x.name==='runtime'&&x.kind==='directory'),true);
  result = await get('/api/files?path=runtime'); assert.equal(result.res.status,200);
  assert.equal(result.body.entries.some(x=>x.name==='runner.log'),true); assert.equal(result.body.entries.some(x=>x.name==='unsafe.bin'),false); assert.equal(result.body.entries.some(x=>x.name==='linked.txt'),false);
  result = await get('/api/files/preview?path=runtime%2Frunner.log'); assert.equal(result.res.status,200); assert.equal(result.body.truncated,true); assert.ok(result.body.preview.length<=64*1024); assert.match(result.body.preview,/api_key=\[REDACTED\]/); assert.equal(result.body.preview.includes('fixture-super-secret-token-123456'),false);
  result = await get('/api/files?path=..%2F..'); assert.equal(result.res.status,400);
  result = await get('/api/files/preview?path=workflow.db'); assert.equal(result.res.status,403);
  result = await get('/api/files/preview?path=runtime%2Funsafe.bin'); assert.equal(result.res.status,403);
  result = await get('/api/files/preview?path=runtime%2Flinked.txt'); assert.equal(result.res.status,403);

  // Serving security headers, local-only Host/Origin guard, and read-only method boundary.
  result = await get('/'); assert.equal(result.res.status,200); assert.match(result.res.headers.get('content-security-policy'),/default-src 'self'/); assert.equal(result.res.headers.get('x-content-type-options'),'nosniff'); assert.match(result.body,/Search workflows…/); assert.match(result.body,/data-view="roles"/); assert.match(result.body,/data-view="batches"/); assert.match(result.body,/id="role-list"/); assert.match(result.body,/id="batch-list"/); assert.match(result.body,/id="individual-execution-list"/);
  assert.match(result.body,/id="attention-list"/); assert.match(result.body,/id="clear-workflow-filters"/); assert.match(result.body,/ux-overrides\.css/);
  result = await get('/ux-overrides.css'); assert.equal(result.res.status,200); assert.match(result.body,/\.attention-panel/); assert.match(result.body,/\.pin-button/); assert.match(result.body,/\.attention-list\s*\{\s*display:\s*grid/); assert.match(result.body,/\.attention-head\s*\{\s*display:\s*flex/); assert.match(result.body,/\.registry-summary/); assert.match(result.body,/\.registry-summary\.batch-summary-grid/); assert.match(result.body,/\.individual-executions-panel \.data-table/); assert.match(result.body,/\.role-skill-card/); assert.match(result.body,/\.batch-item-card/); assert.match(result.body,/color-scheme:\s*light/); assert.match(result.body,/--bg:\s*#f2f4f3/); assert.match(result.body,/max-width:\s*720px/); assert.doesNotMatch(result.body,/linear-gradient|radial-gradient|filter:\s*blur|backdrop-filter:\s*blur|hover:scale/);
  result = await get('/app.js'); assert.equal(result.res.status,200); assert.match(result.body,/function isStaleJob/); assert.match(result.body,/function copyText/); assert.match(result.body,/sessionStorage/); assert.match(result.body,/data-quick-status/); assert.match(result.body,/auto-refresh every 20s/); assert.match(result.body,/setInterval\([^\n]+20000\)/); assert.match(result.body,/el\('details','payload-block'\)/); assert.match(result.body,/assign_children/); assert.match(result.body,/function loadRoles\(/); assert.match(result.body,/function loadBatches\(/); assert.match(result.body,/individual-execution-list/); assert.match(result.body,/finishedCell\.append\(finished\?relativeTime\(finished\)/); assert.match(result.body,/taskRoleLabel\(/); assert.match(result.body,/querySelector\('\.filter-rail'\)\?\.classList\.add\('hidden'\)/); assert.match(result.body,/workflow-results-meta.*state\.jobTotal.*search applied/); assert.match(result.body,/updatedTd\.append\(relativeTime\(job\.updated_at\)\)/); assert.match(result.body,/actionsTd\.append\(actions\)/);
  result = await get('/not-an-asset.js'); assert.equal(result.res.status,404);
  result = await get('/api/health',{'origin':'http://attacker.example'}); assert.equal(result.res.status,403);
  result = await rawGet('/api/health',{'host':'attacker.example'}); assert.equal(result.res.status,403);
  const post = await fetch(`${base}/api/jobs`,{method:'POST'}); assert.equal(post.status,405);
  assert.throws(()=>createDashboardServer({host:'0.0.0.0',port:0,dataDir,dbPath}),/loopback|127\.0\.0\.1/);

  // The connection is native read-only: attempting to open a write connection with readOnly fails.
  const readOnly = new DatabaseSync(dbPath,{readOnly:true});
  assert.throws(()=>readOnly.exec('INSERT INTO jobs(job_id,conversation_key,title,state,status,created_at,updated_at) VALUES("no","x","x","x","active","x","x")'));
  readOnly.close();
  console.log('PASS dashboard: read-only SQLite, overview, job filters/details, event/artifact bounds, safe file browser, Host/Origin and method guards');
} finally {
  await app.close();
  fs.rmSync(temp,{recursive:true,force:true});
}
