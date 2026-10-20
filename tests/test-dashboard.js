import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createDashboardServer } from '../dashboard/server.js';
import { createPolicySnapshot, initializeWorkflowPolicyStore, normalizePolicyDefinition } from '../src/runtime/workflow/policy-contract.js';
import { canonicalJson } from '../src/runtime/workflow/plan.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-dashboard-test-'));
const dataDir = path.join(temp, 'data');
const filesRoot = path.join(temp, 'workspace');
const dbPath = path.join(dataDir, 'workflow.db');
fs.mkdirSync(path.join(filesRoot, 'runtime'), { recursive: true });
fs.mkdirSync(path.join(filesRoot, 'docs'), { recursive: true });
fs.mkdirSync(path.join(filesRoot, '.private'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'case01-snapshots'), { recursive: true });
fs.writeFileSync(path.join(filesRoot, 'README.md'), '# Workspace fixture\\n');
fs.writeFileSync(path.join(filesRoot, 'package.json'), '{"name":"dashboard-files-root-fixture"}\\n');
fs.writeFileSync(path.join(filesRoot, 'docs', 'start-here.md'), 'Workspace browse root is independent from the workflow database.\\n');
fs.writeFileSync(path.join(filesRoot, 'runtime', 'runner.log'), `hello from local runtime\\napi_key=fixture-super-secret-token-123456\\n${'x'.repeat(70_000)}`);
fs.writeFileSync(path.join(filesRoot, 'runtime', 'unsafe.bin'), Buffer.from([0,1,2,3]));
fs.writeFileSync(path.join(filesRoot, '.private', 'private.txt'), 'must not be exposed through a hidden directory/symlink');
fs.writeFileSync(path.join(filesRoot, '.env'), 'API_KEY=hidden-dotfile-secret');
fs.writeFileSync(path.join(filesRoot, 'workflow.db'), 'database sentinel must be hidden');
fs.writeFileSync(path.join(filesRoot, 'workflow.db-wal'), 'database WAL sentinel must be hidden');
try { fs.symlinkSync(path.join(filesRoot, '.private', 'private.txt'), path.join(filesRoot, 'runtime', 'linked.txt')); } catch {}
// Build an isolated local Git fixture to validate the read-only status/diff API.
fs.writeFileSync(path.join(filesRoot, '.gitignore'), 'runtime/\ndocs/\n.env\nworkflow.db*\n.private/\n');
fs.writeFileSync(path.join(filesRoot, 'sample.js'), 'export const value = 1;\n');
fs.writeFileSync(path.join(filesRoot, 'delete-me.js'), 'export const removeMe = true;\n');
fs.writeFileSync(path.join(filesRoot, 'staged.js'), 'export const stagedValue = 1;\n');
fs.writeFileSync(path.join(filesRoot, 'rename-source.js'), 'export const renameValue = true;\n');
execFileSync('git', ['init', '-q'], { cwd: filesRoot });
execFileSync('git', ['config', 'user.name', 'Dashboard Fixture'], { cwd: filesRoot });
execFileSync('git', ['config', 'user.email', 'dashboard-fixture@example.invalid'], { cwd: filesRoot });
execFileSync('git', ['add', '.gitignore', 'README.md', 'sample.js', 'delete-me.js', 'staged.js', 'rename-source.js'], { cwd: filesRoot });
execFileSync('git', ['commit', '-qm', 'fixture baseline'], { cwd: filesRoot });
fs.writeFileSync(path.join(filesRoot, 'sample.js'), 'export const value = 2;\n');
fs.writeFileSync(path.join(filesRoot, 'added.js'), 'export const newValue = true;\n');
fs.writeFileSync(path.join(filesRoot, 'staged.js'), 'export const stagedValue = 2;\n');
execFileSync('git', ['add', 'staged.js'], { cwd: filesRoot });
fs.writeFileSync(path.join(filesRoot, 'staged.js'), 'export const stagedValue = 3;\n');
fs.rmSync(path.join(filesRoot, 'delete-me.js'));
execFileSync('git', ['mv', 'rename-source.js', 'renamed file.js'], { cwd: filesRoot });
fs.writeFileSync(path.join(filesRoot, 'space name.js'), 'export const spaced = true;\n');
fs.mkdirSync(path.join(dataDir, 'case01-snapshots'), { recursive: true });

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
initializeWorkflowPolicyStore(db);
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
const oversizedMetadataObject = JSON.parse(oversizedTaskMetadata);
oversizedMetadataObject.custom_role_skills[0].files.push({path:'/home/red-team/private-skill/references/private.md',sha256:'c'.repeat(64)});
oversizedMetadataObject.raw_metadata_marker = 'OVERSIZED_TASK_METADATA_RAW_SENTINEL_73af';
const oversizedTaskMetadataWithPath = JSON.stringify(oversizedMetadataObject);
assert.ok(oversizedTaskMetadataWithPath.length > 4_000);
db.prepare('INSERT INTO tasks(task_id,job_id,role,description,status,dependency_json,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('task-demo-003','job-demo-001','custom-task-2','Inspect oversized metadata safely','completed','[]',oversizedTaskMetadataWithPath,now,now);
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
const pathDisclosureSkill = {name:'private-skill-fixture',description:'Path disclosure regression fixture.',source:{kind:'local',location:'/home/red-team/private-skill'},instructions:'Only this safe preview should be available.',files:[{path:'/home/red-team/private-skill/references/private.md',sha256:'c'.repeat(64),size_bytes:31}]};
db.prepare('INSERT INTO custom_role_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('fixture-analyst',1,'Fixture Evidence Analyst','Produces grounded findings from upstream artifacts.','Act as evidence analyst.',JSON.stringify(['job.request','research']),'research',JSON.stringify(['research.collect']),JSON.stringify(['workspace.read','artifact.create']),JSON.stringify(['workflow_get','workflow_artifacts']),JSON.stringify(skillSnapshot),now,'fixture-user');
db.prepare('INSERT INTO custom_role_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('fixture-analyst',2,'Fixture Evidence Analyst','Version 2 with no attached skill.','Act as evidence analyst; version 2.',JSON.stringify(['job.request','research']),'research',JSON.stringify(['research.collect']),JSON.stringify(['workspace.read','artifact.create']),JSON.stringify(['workflow_get','workflow_artifacts']),JSON.stringify([]),now,'fixture-user');
const overlaySkillSnapshot = [{name:'architecture-evidence',description:'Validate boundaries and failure modes.',source:{kind:'local',location:'/home/test-user/.agents/skills/architecture-evidence'},sha256:'f'.repeat(64),instructions:'Check boundaries, interfaces, and failure modes.',files:[]}];
db.prepare('INSERT INTO custom_role_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('fixture-architect-profile',1,'Fixture Architect Profile','Supplementary architecture guidance.','Use evidence-led architecture analysis.',JSON.stringify(['job.request','requirements','research']),'architecture',JSON.stringify(['architecture.design']),JSON.stringify(['workspace.read','artifact.create']),JSON.stringify(['workflow_get','workflow_artifacts']),JSON.stringify(overlaySkillSnapshot),now,'fixture-user');
db.prepare('INSERT INTO custom_workflow_versions VALUES(?,?,?,?,?,?,?,?)').run('fixture-review-pipeline',1,'Fixture Review Pipeline','Three-stage review using a pinned custom profile.',JSON.stringify(['job.request']),JSON.stringify([{id:'analyze-evidence',role_id:'fixture-analyst',role_version:1,input_contract:['job.request'],output_artifact_type:'research',depends_on:[]}]),now,'fixture-user');
db.prepare('INSERT INTO events VALUES(?,?,?,?,?)').run('event-overlay-proposal','job-demo-002','job.proposal_requested',JSON.stringify({workflowId:'standard-engineering',role_profile_bindings:[{role:'architect',custom_role_id:'fixture-architect-profile',custom_role_version:1,profile_hash:'9'.repeat(64)}]}),new Date(Date.now()+2000).toISOString());
const fixturePolicy = normalizePolicyDefinition({
  policy_id:'fixture-secure-release', name:'Fixture Secure Release', description:'Require local-only execution and QA evidence.',
  constraints:[{id:'only-local',type:'local_execution_only'}],
  success_criteria:[{id:'qa-accepted',type:'artifact_field_equals',artifact_type:'qa-report',producer_role:'qa',field:'decision',expected:'accept'}]
});
const fixturePolicySnapshot = createPolicySnapshot(fixturePolicy.policy_id,1,fixturePolicy);
db.prepare('INSERT INTO workflow_policy_versions VALUES(?,?,?,?,?,?,?,?)').run(fixturePolicy.policy_id,1,fixturePolicy.name,fixturePolicy.description,canonicalJson(fixturePolicy),fixturePolicySnapshot.content_hash,now,'fixture-user');
db.prepare('INSERT INTO workflow_policy_attachments VALUES(?,?,?,?,?,?)').run('job-demo-001',fixturePolicy.policy_id,1,fixturePolicySnapshot.content_hash,now,'fixture-user');
db.prepare('INSERT INTO workflow_policy_events VALUES(?,?,?,?,?,?,?)').run('fixture-policy-created',fixturePolicy.policy_id,1,'created',JSON.stringify({policy_id:fixturePolicy.policy_id,version:1,content_hash:fixturePolicySnapshot.content_hash}),now,'fixture-user');
db.prepare('INSERT INTO workflow_policy_events VALUES(?,?,?,?,?,?,?)').run('fixture-policy-violation',fixturePolicy.policy_id,1,'violation_detected',JSON.stringify({job_id:'job-demo-001',policy_id:fixturePolicy.policy_id,policy_version:1,plan_hash:'a'.repeat(64),predicate_id:'p-fixture-secure-release-qa-accepted',predicate_type:'artifact_field_equals',reason:'fixture predicate failed'}),new Date(Date.now()+1000).toISOString(),'workflow-runtime');
const corruptPolicy = normalizePolicyDefinition({policy_id:'fixture-corrupt-policy',name:'Fixture Corrupt Policy',constraints:[{id:'local-only',type:'local_execution_only'}]});
db.prepare('INSERT INTO workflow_policy_versions VALUES(?,?,?,?,?,?,?,?)').run(corruptPolicy.policy_id,1,corruptPolicy.name,corruptPolicy.description,canonicalJson(corruptPolicy),'f'.repeat(64),now,'fixture-user');
db.prepare('UPDATE tasks SET role=?,metadata_json=? WHERE task_id=?').run('custom-task-1',JSON.stringify({workflow_plan_task_id:'analyze-evidence',custom_role_id:'fixture-analyst',custom_role_version:1,custom_role_name:'Fixture Evidence Analyst',custom_role_skills:[...skillSnapshot,pathDisclosureSkill],raw_metadata_marker:'PARSED_TASK_METADATA_RAW_SENTINEL_92bd'}), 'task-demo-001');
db.prepare('UPDATE tasks SET metadata_json=? WHERE task_id=?').run(JSON.stringify({custom_role_id:'/home/red-team/private-skill',custom_role_version:1,custom_role_name:'Path-shaped invalid role ID'}), 'task-demo-002');
db.close();

const savedRunalithFilesRoot = process.env.RUNALITH_DASHBOARD_FILES_ROOT;
const savedChatFilesRoot = process.env.CHAT_ON_STEROIDS_DASHBOARD_FILES_ROOT;
delete process.env.RUNALITH_DASHBOARD_FILES_ROOT;
delete process.env.CHAT_ON_STEROIDS_DASHBOARD_FILES_ROOT;
const rootOptionProbe = createDashboardServer({host:'127.0.0.1',port:0,dataDir,dbPath,filesRoot});
assert.equal(rootOptionProbe.filesRoot,fs.realpathSync(filesRoot),'explicit filesRoot should be independent of database dataDir');
await rootOptionProbe.close();
process.env.RUNALITH_DASHBOARD_FILES_ROOT = filesRoot;
const runalithEnvProbe = createDashboardServer({host:'127.0.0.1',port:0,dataDir,dbPath});
assert.equal(runalithEnvProbe.filesRoot,fs.realpathSync(filesRoot),'RUNALITH_DASHBOARD_FILES_ROOT should configure the browse root');
await runalithEnvProbe.close();
delete process.env.RUNALITH_DASHBOARD_FILES_ROOT;
process.env.CHAT_ON_STEROIDS_DASHBOARD_FILES_ROOT = filesRoot;
const chatEnvProbe = createDashboardServer({host:'127.0.0.1',port:0,dataDir,dbPath});
assert.equal(chatEnvProbe.filesRoot,fs.realpathSync(filesRoot),'Chat On Steroids environment alias should configure the browse root');
await chatEnvProbe.close();
delete process.env.CHAT_ON_STEROIDS_DASHBOARD_FILES_ROOT;
const compatibilityProbe = createDashboardServer({host:'127.0.0.1',port:0,dataDir,dbPath});
assert.equal(compatibilityProbe.filesRoot,fs.realpathSync(dataDir),'explicit dataDir remains the browse-root fallback');
await compatibilityProbe.close();
const cwdProbe = createDashboardServer({host:'127.0.0.1',port:0,dbPath});
assert.equal(cwdProbe.filesRoot,fs.realpathSync(process.cwd()),'normal launch defaults browsing to process.cwd()');
await cwdProbe.close();
if(savedRunalithFilesRoot==null) delete process.env.RUNALITH_DASHBOARD_FILES_ROOT; else process.env.RUNALITH_DASHBOARD_FILES_ROOT=savedRunalithFilesRoot;
if(savedChatFilesRoot==null) delete process.env.CHAT_ON_STEROIDS_DASHBOARD_FILES_ROOT; else process.env.CHAT_ON_STEROIDS_DASHBOARD_FILES_ROOT=savedChatFilesRoot;
const app = createDashboardServer({host:'127.0.0.1',port:0,dataDir,dbPath,filesRoot});
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
  assert.equal(result.res.status,200); assert.equal(result.body.counts.jobs,2); assert.equal(result.body.counts.tasks,3); assert.equal(result.body.counts.events,3); assert.equal(result.body.counts.custom_profiles,2); assert.equal(result.body.counts.role_versions,3); assert.equal(result.body.counts.custom_workflows,1); assert.equal(result.body.counts.individual_executions,2);
  assert.equal(result.body.job_statuses.find(x=>x.status==='active').count,1);

  // The role registry exposes durable custom profiles, skill snapshots and exact workflow role-version pins without enabling writes.
  result = await get('/api/roles'); assert.equal(result.res.status,200);
  assert.equal(result.body.summary.custom_profiles,2); assert.equal(result.body.summary.custom_role_versions,3);
  assert.equal(result.body.custom_roles.length,2); assert.ok(result.body.custom_roles.some(role=>role.role_id==='fixture-analyst'));
  assert.equal(result.body.summary.builtin_profile_pins,1);
  const overlayPin=result.body.builtin_role_profile_pins[0];
  assert.equal(overlayPin.job_id,'job-demo-002'); assert.equal(overlayPin.built_in_role,'architect');
  assert.equal(overlayPin.role_id,'fixture-architect-profile'); assert.equal(overlayPin.role_version,1);
  assert.equal(overlayPin.profile_hash,'9'.repeat(64)); assert.deepEqual(overlayPin.skills,['architecture-evidence']);
  assert.equal(overlayPin.workflow_status,'failed','proposal pin should show current workflow state without implying approval');
  assert.equal(result.body.custom_roles[0].version,2); assert.equal(result.body.custom_roles[0].skills.length,0,'latest version exposes its own skill state, not a prior version');
  result = await get('/api/roles?versions=all'); assert.equal(result.body.custom_roles.length,3);
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
  result = await get('/api/roles?q=architecture-evidence'); assert.equal(result.body.builtin_role_profile_pins.length,1,'role registry search must include overlay Skill names');
  result = await get('/api/roles?q=fixture-analyst'); assert.equal(result.body.builtin_role_profile_pins.length,0,'overlay pins must obey registry search filters');

  // Batch history reads the durable batch ledger, not specialist task counts.
  result = await get('/api/batches'); assert.equal(result.res.status,200);
  assert.equal(result.body.total,1); assert.equal(result.body.summary.batches,1); assert.equal(result.body.summary.items,1);
  assert.equal(JSON.stringify(result.body).includes('/home/red-team/private-skill'),false,'individual execution projection must not leak invalid path-shaped role IDs');
  assert.equal(result.body.individual_items.find(item=>item.task_id==='task-demo-002').role_display,'qa');
  assert.equal(Object.hasOwn(result.body.individual_items.find(item=>item.task_id==='task-demo-002'),'custom_role_id'),false);
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

  // Policy pack snapshots, attachments, hashes and append-only audit are exposed as a bounded read-only registry.
  result = await get('/api/policies'); assert.equal(result.res.status,200,JSON.stringify(result.body));
  assert.equal(result.body.summary.policy_count,2); assert.equal(result.body.summary.policy_versions,2);
  assert.equal(result.body.summary.attachments,1); assert.equal(result.body.summary.audit_events,2); assert.equal(result.body.summary.recorded_violations,1);
  const securePolicyRow = result.body.policies.find(policy=>policy.policy_id==='fixture-secure-release');
  assert.equal(securePolicyRow.content_hash,fixturePolicySnapshot.content_hash);
  assert.equal(securePolicyRow.constraints[0].type,'local_execution_only');
  assert.equal(securePolicyRow.validation_status,'valid'); assert.equal(securePolicyRow.violation_count,1);
  const corruptPolicyRow = result.body.policies.find(policy=>policy.policy_id==='fixture-corrupt-policy');
  assert.equal(corruptPolicyRow.validation_status,'invalid','the dashboard must flag a stored definition/hash mismatch');
  assert.match(corruptPolicyRow.validation_reason,/hash mismatch/i);
  assert.equal(result.body.attachments[0].job_id,'job-demo-001'); assert.equal(result.body.attachments[0].version,1); assert.equal(result.body.attachments[0].validation_status,'valid');
  assert.equal(result.body.events[0].event_type,'violation_detected');
  result = await get('/api/policies?versions=all&q=secure'); assert.equal(result.body.policies.length,1); assert.equal(result.body.attachments.length,1);

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
  assert.equal(parsedMetaTask.metadata.custom_role_skills[1].source.label,'Local skill · private-skill');
  assert.equal(parsedMetaTask.metadata.custom_role_skills[1].files[0].path,'private.md','nested absolute supporting-file paths are reduced to a basename');
  const oversizedMetaTask=result.body.tasks.find(x=>x.task_id==='task-demo-003');
  assert.equal(oversizedMetaTask.metadata_truncated,true); assert.equal(oversizedMetaTask.metadata_malformed,false); assert.equal(oversizedMetaTask.metadata_available,false);
  assert.equal(oversizedMetaTask.metadata.custom_role_id,'fixture-analyst'); assert.equal(oversizedMetaTask.metadata.custom_role_version,1); assert.equal(oversizedMetaTask.metadata.workflow_plan_task_id,'analyze-large-metadata');
  assert.equal(Object.hasOwn(oversizedMetaTask.metadata,'custom_role_skills'),false,'oversized metadata must not leak the raw/truncated skill object');
  assert.equal(result.body.tasks.find(x=>x.task_id==='task-demo-002').custom_role,null,'path-shaped role identifiers must not be echoed as custom roles');
  assert.equal(result.body.tasks.find(x=>x.task_id==='task-demo-002').role_display,'qa');
  const serializedJobDetails=JSON.stringify(result.body);
  for(const secretPath of ['/home/test-user/.agents/skills/review-evidence','/home/test-user/.agents/skills/review-evidence/private.md','C:\\Users\\fixture\\AppData\\private.txt','\\\\server\\share\\private.md','/home/red-team/private-skill','/home/red-team/private-skill/references/private.md','C:\\Users\\red-team\\private\\skill.txt','\\\\red-team\\share\\private.md','PARSED_TASK_METADATA_RAW_SENTINEL_92bd','OVERSIZED_TASK_METADATA_RAW_SENTINEL_73af']) assert.equal(serializedJobDetails.includes(secretPath),false,`job detail response must not expose ${secretPath}`);
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

  // File browsing uses a separate workspace root while preserving existing file security guarantees.
  result = await get('/api/health'); assert.equal(result.res.status,200);
  assert.equal(result.body.data_root,path.basename(dataDir)); assert.equal(result.body.files_root,path.basename(filesRoot));
  assert.equal(JSON.stringify(result.body).includes(filesRoot),false,'health labels must not leak absolute paths');
  result = await get('/api/files'); assert.equal(result.res.status,200);
  assert.equal(result.body.root_label,path.basename(filesRoot)); assert.equal(result.body.path,'');
  assert.equal(result.body.entries.some(x=>x.name==='README.md'&&x.kind==='file'),true);
  assert.equal(result.body.entries.some(x=>x.name==='package.json'&&x.kind==='file'),true);
  assert.equal(result.body.entries.some(x=>x.name==='docs'&&x.kind==='directory'),true);
  assert.equal(result.body.entries.some(x=>x.name==='runtime'&&x.kind==='directory'),true);
  assert.equal(result.body.entries.some(x=>['workflow.db','workflow.db-wal','.env','.private'].includes(x.name)),false);
  result = await get('/api/files?path=docs'); assert.equal(result.res.status,200);
  assert.equal(result.body.entries.some(x=>x.name==='start-here.md'&&x.kind==='file'),true);
  result = await get('/api/files/preview?path=docs%2Fstart-here.md'); assert.equal(result.res.status,200);
  assert.match(result.body.preview,/independent from the workflow database/);
  result = await get('/api/git/status'); assert.equal(result.res.status,200);
  assert.equal(result.body.git_available,true);
  const gitByPath = new Map(result.body.entries.map(entry=>[entry.path,entry]));
  assert.equal(gitByPath.get('sample.js')?.worktree_status,'modified','working-tree-only edits must be represented distinctly');
  assert.equal(gitByPath.get('staged.js')?.index_status,'modified','staged edits must be represented in the index column');
  assert.equal(gitByPath.get('staged.js')?.worktree_status,'modified','subsequent edits must remain distinguishable from staged edits');
  assert.equal(gitByPath.get('added.js')?.kind,'untracked','untracked files must not be treated as clean');
  assert.equal(gitByPath.get('delete-me.js')?.kind,'deleted','deleted files must remain reviewable');
  assert.equal(gitByPath.get('renamed file.js')?.kind,'renamed','renames and filenames with spaces must be parsed as one path');
  assert.equal(gitByPath.get('renamed file.js')?.old_path,'rename-source.js','rename source path should be preserved');
  assert.equal(gitByPath.get('space name.js')?.kind,'untracked','spaces in supported paths must not corrupt status parsing');
  assert.equal(result.body.entries.some(entry=>String(entry.path).startsWith('.')),false,'hidden paths must not leak through Git status');
  assert.equal(JSON.stringify(result.body).includes(filesRoot),false,'Git status must not disclose absolute workspace paths');
  result = await get('/api/git/diff?path=sample.js&mode=working-tree'); assert.equal(result.res.status,200);
  assert.equal(result.body.git_available,true); assert.match(result.body.patch,/export const value = 1/); assert.match(result.body.patch,/export const value = 2/);
  result = await get('/api/git/diff?path=staged.js&mode=staged'); assert.equal(result.res.status,200);
  assert.match(result.body.patch,/stagedValue = 1/); assert.match(result.body.patch,/stagedValue = 2/);
  result = await get('/api/git/diff?path=staged.js&mode=unstaged'); assert.equal(result.res.status,200);
  assert.match(result.body.patch,/stagedValue = 2/); assert.match(result.body.patch,/stagedValue = 3/);
  result = await get('/api/git/diff?path=added.js&mode=working-tree'); assert.equal(result.res.status,200);
  assert.equal(result.body.status,'untracked'); assert.match(result.body.patch,/newValue/);
  result = await get('/api/git/diff?path=space%20name.js&mode=working-tree'); assert.equal(result.res.status,200); assert.match(result.body.patch,/spaced/);
  result = await get('/api/git/status?path=runtime'); assert.equal(result.res.status,200);
  assert.equal(result.body.entries.some(entry=>String(entry.path).startsWith('runtime/')),false,'ignored/hidden/unapproved descendants stay out of Git results');
  result = await get('/api/git/status?path=..'); assert.equal(result.res.status,400);
  result = await get('/api/git/diff?path=../data/workflow.db&mode=working-tree'); assert.equal(result.res.status,403);
  result = await get('/api/files?path=runtime'); assert.equal(result.res.status,200);
  assert.equal(result.body.entries.some(x=>x.name==='runner.log'),true); assert.equal(result.body.entries.some(x=>x.name==='unsafe.bin'),false); assert.equal(result.body.entries.some(x=>x.name==='linked.txt'),false);
  result = await get('/api/files/preview?path=runtime%2Frunner.log'); assert.equal(result.res.status,200); assert.equal(result.body.truncated,true); assert.ok(result.body.preview.length<=64*1024); assert.match(result.body.preview,/api_key=\[REDACTED\]/); assert.equal(result.body.preview.includes('fixture-super-secret-token-123456'),false);
  result = await get('/api/files?path=..%2F..'); assert.equal(result.res.status,400);
  result = await get('/api/files/preview?path=workflow.db'); assert.equal(result.res.status,403);
  result = await get('/api/files/preview?path=runtime%2Funsafe.bin'); assert.equal(result.res.status,403);
  result = await get('/api/files/preview?path=runtime%2Flinked.txt'); assert.equal(result.res.status,403);
  // Serving security headers, local-only Host/Origin guard, and read-only method boundary.
  result = await get('/'); assert.equal(result.res.status,200); assert.match(result.res.headers.get('content-security-policy'),/default-src 'self'/); assert.equal(result.res.headers.get('x-content-type-options'),'nosniff'); assert.match(result.body,/<title>Runalith Local Workbench<\/title>/); assert.match(result.body,/RUNALITH<span> \/ <\/span>WORKBENCH/); assert.match(result.body,/RUNALITH <span class="footer-separator">\/<\/span> LOCAL WORKBENCH/); assert.doesNotMatch(result.body,/LOCAL <span class="footer-separator">\/<\/span> WORKFLOW MONITOR/,'legacy shell branding removed'); assert.match(result.body,/LOCAL DASHBOARD/); assert.doesNotMatch(result.body,/ORBIT \/ OPS|ORBIT DASHBOARD/,'user-facing dashboard labels use generic wording'); assert.match(result.body,/Search everything…/); assert.match(result.body,/id="wb-primary-sidebar"/); assert.match(result.body,/id="wb-sidebar-groups"/); assert.match(result.body,/data-sidebar-group="explorer"/); assert.match(result.body,/data-sidebar-group="sourceControl"/); assert.match(result.body,/data-sidebar-group="runalith"/); assert.match(result.body,/id="wb-explorer-sidebar"/); assert.match(result.body,/id="wb-source-sidebar"/); assert.match(result.body,/id="wb-utility-view"/); assert.match(result.body,/id="wb-utility-content"/); assert.doesNotMatch(result.body,/<nav class="primary-nav" aria-label="Primary navigation">/,'legacy all-domains sidebar navigation has been replaced by contextual groups'); assert.match(result.body,/data-view="roles"/); assert.match(result.body,/data-view="policies"/); assert.match(result.body,/id="policy-list"/); assert.match(result.body,/id="policy-attachment-list"/); assert.match(result.body,/data-view="batches"/); assert.match(result.body,/id="role-list"/); assert.match(result.body,/id="builtin-role-profile-pin-list"/); assert.match(result.body,/id="batch-list"/); assert.match(result.body,/id="individual-execution-list"/);
  assert.match(result.body,/id="attention-list"/); assert.match(result.body,/id="clear-workflow-filters"/); assert.match(result.body,/ux-overrides\.css/); assert.ok(result.body.includes('aria-keyshortcuts="/"')); assert.ok(result.body.includes('class="skip-link" href="#main-content"')); assert.ok(result.body.includes('aria-current="page"')); assert.ok(result.body.includes('id="last-updated" data-sync-state="syncing"'));
  result = await get('/workbench.css'); assert.equal(result.res.status,200); assert.match(result.body,/\.wb-activity/); assert.match(result.body,/prefers-reduced-motion/);
  result = await get('/workbench.js'); assert.equal(result.res.status,200); assert.match(result.body,/tabs\.setAttribute\('role','navigation'\)/); assert.match(result.body,/aria-current/); assert.doesNotMatch(result.body,/tabs\.setAttribute\('role','tablist'\)/,'the view strip is navigation, not an invalid tablist'); assert.match(result.body,/Source Control/); assert.match(result.body,/wb-command-palette/); assert.match(result.body,/loadTreePath/); assert.match(result.body,/OPEN EDITORS/); assert.match(result.body,/wb-diff-mode/); assert.match(result.body,/searchWorkspace/); assert.match(result.body,/runGlobalSearch/); assert.match(result.body,/renderProblems/); assert.match(result.body,/renderDiagnostics/); assert.match(result.body,/openQuickOpen/); assert.match(result.body,/data-sidebar-group/);
  result = await get('/ux-overrides.css'); assert.equal(result.res.status,200); assert.match(result.body,/\.attention-panel/); assert.match(result.body,/\.pin-button/); assert.match(result.body,/\.attention-list\s*\{\s*display:\s*grid/); assert.match(result.body,/\.attention-head\s*\{\s*display:\s*flex/); assert.match(result.body,/\.registry-summary/); assert.match(result.body,/\.registry-summary\.batch-summary-grid/); assert.match(result.body,/\.individual-executions-panel \.data-table/); assert.match(result.body,/\.role-skill-card/); assert.match(result.body,/\.batch-item-card/); assert.match(result.body,/color-scheme:\s*light/); assert.match(result.body,/--bg:\s*#f2f4f3/); assert.match(result.body,/max-width:\s*720px/); assert.doesNotMatch(result.body,/linear-gradient|radial-gradient|filter:\s*blur|backdrop-filter:\s*blur|hover:scale/); assert.ok(result.body.includes('.skip-link:focus')); assert.ok(result.body.includes('.sync-indicator')); assert.ok(result.body.includes('scrollbar-width: thin')); assert.ok(result.body.includes('overflow-x: auto;')); assert.ok(result.body.includes('@media (prefers-reduced-motion: reduce)'));
  result = await get('/app.js'); assert.equal(result.res.status,200); assert.match(result.body,/function isStaleJob/); assert.ok(result.body.includes('function setSyncUi(mode)')); assert.ok(result.body.includes("setSyncUi('syncing')")); assert.ok(result.body.includes('aria-busy')); assert.ok(result.body.includes("if(mode==='syncing' && !state.lastSync) label.textContent='SYNCING SNAPSHOT';"),'retry before first success restores the syncing label'); assert.ok(result.body.includes("label.textContent='SYNC FAILED'"),'initial refresh failure has an explicit visible label'); assert.ok(result.body.includes('Refresh failed. Last successful snapshot:'),'later failures keep last-success context in the tooltip'); assert.ok(result.body.includes('aria-current')); assert.match(result.body,/function copyText/); assert.match(result.body,/sessionStorage/); assert.match(result.body,/data-quick-status/); assert.match(result.body,/auto-refresh every 20s/); assert.match(result.body,/setInterval\([^\n]+20000\)/); assert.match(result.body,/el\('details','payload-block'\)/); assert.match(result.body,/assign_children/); assert.match(result.body,/function loadRoles\(/); assert.match(result.body,/builtin-role-profile-pin-list/); assert.match(result.body,/proposal pin; approval\/execution not implied/); assert.match(result.body,/function loadBatches\(/); assert.match(result.body,/individual-execution-list/); assert.match(result.body,/finishedCell\.append\(finished\?relativeTime\(finished\)/); assert.match(result.body,/taskRoleLabel\(/); assert.match(result.body,/querySelector\('\.filter-rail'\)\?\.classList\.add\('hidden'\)/); assert.match(result.body,/workflow-results-meta.*state\.jobTotal.*search applied/); assert.match(result.body,/updatedTd\.append\(relativeTime\(job\.updated_at\)\)/); assert.match(result.body,/actionsTd\.append\(actions\)/);
  assert.match(result.body,/async function loadPolicies\(/); assert.match(result.body,/api\/policies/); assert.match(result.body,/policy-event-list/);
  result = await get('/not-an-asset.js'); assert.equal(result.res.status,404);
  result = await get('/api/health',{'origin':'http://attacker.example'}); assert.equal(result.res.status,403);
  result = await rawGet('/api/health',{'host':'attacker.example'}); assert.equal(result.res.status,403);
  const post = await fetch(`${base}/api/jobs`,{method:'POST'}); assert.equal(post.status,405);
  const gitPost = await fetch(`${base}/api/git/status`,{method:'POST'}); assert.equal(gitPost.status,405);
  const gitDiffPost = await fetch(`${base}/api/git/diff?path=sample.js`,{method:'POST'}); assert.equal(gitDiffPost.status,405);
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