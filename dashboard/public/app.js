const state = {
  view: 'overview', overview: null, jobs: [], jobTotal: 0, jobOffset: 0, jobLimit: 50,
  events: [], eventTotal: 0, eventOffset: 0, eventLimit: 80, artifacts: [], artifactTotal: 0, artifactOffset: 0, artifactLimit: 80,
  jobQuery: '', statusFilter: '', phaseFilter: '', eventQuery: '', eventType: '', artifactQuery: '', artifactType: '', filePath: '', selectedEvent: null, selectedArtifact: null,
  currentJob: null, jobTab: 'tasks', autoRefresh: true, lastSync: null, attentionJobs: [], attentionFilter: 'all', pinnedJobs: new Set(), filePreviewPath: '',
  roles: null, roleQuery: '', roleVersions: 'latest', selectedRoleKey: null,
  policies: null, policyQuery: '', policyVersions: 'latest',
  batches: [], batchTotal: 0, batchOffset: 0, batchLimit: 50, batchQuery: '', batchStatus: '', selectedBatchId: null,
  individualExecutions: [], individualExecutionTotal: 0, individualExecutionOffset: 0, individualExecutionLimit: 50
};
const SESSION_KEY = 'orbit-dashboard-session-v1';
const STALE_AFTER_MS = 15 * 60 * 1000;
function loadSessionPrefs() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || '{}'); } catch { return {}; }
}
const sessionPrefs = loadSessionPrefs();
state.jobQuery = typeof sessionPrefs.jobQuery === 'string' ? sessionPrefs.jobQuery : '';
state.statusFilter = typeof sessionPrefs.statusFilter === 'string' ? sessionPrefs.statusFilter : '';
state.phaseFilter = typeof sessionPrefs.phaseFilter === 'string' ? sessionPrefs.phaseFilter : '';
state.pinnedJobs = new Set(Array.isArray(sessionPrefs.pinnedJobs) ? sessionPrefs.pinnedJobs.filter(x => typeof x === 'string') : []);
const $ = id => document.getElementById(id);
const views = ['overview','workflows','roles','policies','batches','events','artifacts','files'];
let toastTimer = null;
let pollTimer = null;
let refreshInFlight = false;

function el(tag, cls = '', value = undefined) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (value !== undefined && value !== null) n.textContent = String(value);
  return n;
}
function append(parent, ...children) { for (const child of children) if (child) parent.append(child); return parent; }
function clear(n) { n.replaceChildren(); }
function fmtNumber(n) { return Number(n || 0).toLocaleString(); }
function ago(value) {
  if (!value) return '—';
  const t = Date.parse(value); if (!Number.isFinite(t)) return '—';
  const seconds = Math.max(0, Math.floor((Date.now()-t)/1000));
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds/60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds/3600)}h ago`;
  if (seconds < 86400*30) return `${Math.floor(seconds/86400)}d ago`;
  return new Date(t).toLocaleDateString();
}
function dateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString([], {month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',second:undefined});
}
function compactId(value, max = 15) { const s=String(value || '—'); return s.length>max?`${s.slice(0,Math.ceil(max/2))}…${s.slice(-Math.floor(max/2))}`:s; }
function statusClass(value) { const s=String(value||'pending').toLowerCase(); if (s.includes('fail')||s.includes('error')||s.includes('reject')) return 'status-failed'; if(s.includes('complete')||s.includes('success')||s==='accept') return 'status-completed'; if(s==='active'||s==='running'||s==='executing'||s==='spawning'||s==='assign_children') return 'status-active'; if(s==='cancelled'||s==='pending'||s==='waiting'||s.includes('await')) return 'status-pending'; return 'status-live'; }
function pill(value) { return el('span', `status-pill ${statusClass(value)}`, String(value || 'unknown').replaceAll('_',' ')); }
function saveSessionPrefs() {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({jobQuery:state.jobQuery,statusFilter:state.statusFilter,phaseFilter:state.phaseFilter,pinnedJobs:[...state.pinnedJobs]})); } catch {}
}
function relativeTime(value) {
  const node=el('time','',ago(value));
  if(value){node.dateTime=String(value);node.title=dateTime(value);}
  return node;
}
function jobStatus(job) { return String(job?.status || job?.state || '').toLowerCase(); }
function isFailedJob(job) { return /fail|error|reject|blocked/.test(jobStatus(job)); }
function isActiveJob(job) { return /^(active|running|executing|in[._ -]?progress|spawning|assign_children)$/.test(jobStatus(job)); }
function isStaleJob(job, now=Date.now()) {
  if(!isActiveJob(job) || !job?.updated_at) return false;
  const stamp=Date.parse(job.updated_at);
  return Number.isFinite(stamp) && now-stamp>STALE_AFTER_MS;
}
function copyButton(value,label='Copy') {
  const button=el('button','copy-button',label);button.type='button';button.title=`Copy ${label.toLowerCase()}`;
  button.addEventListener('click',event=>{event.stopPropagation();copyText(value,label).catch(()=>{});});
  return button;
}
async function copyText(value,label='value') {
  const text=String(value??'');if(!text){notify(`Nothing to copy`,true);return false;}
  try {
    if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);notify(`${label} copied`);return true;}
  } catch {}
  let ok=false;const input=el('textarea','copy-fallback');input.value=text;input.setAttribute('aria-label',`Copy ${label}`);document.body.append(input);input.focus();input.select();
  try { ok=Boolean(document.execCommand('copy')); } catch { ok=false; }
  input.remove();notify(ok?`${label} copied`:`Copy unavailable — select the value in its detail view`,!ok);return ok;
}
function togglePinned(jobId, job=null) {
  if(state.pinnedJobs.has(jobId))state.pinnedJobs.delete(jobId);else {
    if(state.pinnedJobs.size>=20){notify('Session pins are limited to 20 workflows',true);return;}
    state.pinnedJobs.add(jobId);
  }
  if(job&&!state.attentionJobs.some(x=>x.job_id===jobId))state.attentionJobs.push(job);
  saveSessionPrefs();renderAttentionList();
  if(state.view==='workflows')renderJobsTable(state.jobs,$('all-jobs'),openJob,'all');
  notify(state.pinnedJobs.has(jobId)?'Added to session pins':'Removed from session pins');
}
function pinButton(job) {
  const pinned=state.pinnedJobs.has(job.job_id),button=el('button',`pin-button${pinned?' pinned':''}`,pinned?'★':'☆');
  button.type='button';button.title=pinned?'Unpin workflow':'Pin workflow for this session';button.setAttribute('aria-label',button.title);button.setAttribute('aria-pressed',String(pinned));
  button.addEventListener('click',event=>{event.stopPropagation();togglePinned(job.job_id,job);});return button;
}
function notify(message, error = false) {
  const t=$('toast'); t.textContent=message; t.className=`toast show${error?' error':''}`;
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),2800);
}
async function api(path) {
  const response = await fetch(path, { method:'GET', credentials:'same-origin', headers:{'accept':'application/json'} });
  const data = await response.json().catch(()=>({error:'Invalid response from local dashboard'}));
  if (!response.ok) throw new Error(data.details || data.error || `Request failed (${response.status})`);
  return data;
}
function setBanner(message = '') {
  const n=$('connection-banner');
  if(!message){n.classList.add('hidden');n.textContent='';return;}
  n.textContent=message;n.classList.remove('hidden');
}
function updateHero(title, accent, subtitle) {
  const h=$('page-title'); clear(h); h.append(document.createTextNode(`${title} `), el('em','',accent)); $('page-subtitle').textContent=subtitle;
}
function setView(view) {
  if(!views.includes(view)) return;
  state.view=view;
  for(const v of views) $(`${v}-view`).classList.toggle('hidden',v!==view);
  if(view==='workflows'){
    const detail=$('job-detail-shell');if(detail)detail.remove();state.currentJob=null;
    $('workflows-view').querySelector('.section-toolbar')?.classList.remove('hidden');$('workflows-view').querySelector('.table-panel')?.classList.remove('hidden');
  }
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  const meta={overview:['Operations','Overview','Workflow status, recent activity and exceptions.'],workflows:['Workflows','Registry','Search, filter and inspect workflow runs.'],roles:['Role','Registry','Saved role versions, skill snapshots and custom workflow pins.'],policies:['Workflow','Policies','Reusable policy packs, immutable versions and workflow attachments.'],batches:['Batch','Execution','Durable command batches and per-item execution evidence.'],events:['Events','Stream','Recent events across workflow runs.'],artifacts:['Artifacts','Library','Stored results, reports and evidence.'],files:['Local files','Explorer','Read-only text and log previews.']}[view];
  updateHero(...meta); $('crumb-current').textContent=({overview:'Overview',workflows:'Workflows',roles:'Roles & skills',policies:'Policies',batches:'Batch execution',events:'Event stream',artifacts:'Artifacts',files:'File explorer'})[view];
  if(view==='workflows') loadJobs(); if(view==='roles') loadRoles(); if(view==='policies') loadPolicies(); if(view==='batches') loadBatches(); if(view==='events') loadEvents(); if(view==='artifacts') loadArtifacts(); if(view==='files') loadFiles(state.filePath);
  if(view==='overview') renderOverview();
}
function setCountsText(id, count) { $(id).textContent=fmtNumber(count); }
function mapCount(rows,key,value='count') { return Object.fromEntries((rows||[]).map(r=>[r[key],Number(r[value]||0)])); }
function getJobStatusCount(o,status) { return mapCount(o?.job_statuses,'status')[status]||0; }
function getTaskStatusCount(o,status) { return mapCount(o?.task_statuses,'status')[status]||0; }
function updateSparks(counts) {
  const variants=[['spark-jobs','jobs'],['spark-tasks','tasks'],['spark-events','events'],['spark-artifacts','artifacts']];
  for(const [id,key] of variants) { const target=$(id); clear(target); const arr=(counts||[]).slice(-9); const max=Math.max(1,...arr.map(x=>Number(x.count)||0)); for(const x of arr){const b=el('i');b.style.cssText=`display:inline-block;vertical-align:bottom;width:3px;margin-right:2px;height:${Math.max(2,12*Number(x.count||0)/max)}px;background:currentColor;opacity:.45`;target.append(b);} }
}
function renderActivityChart(activity) {
  const c=$('activity-chart');clear(c); const days=[]; const today=new Date(); today.setUTCHours(0,0,0,0);
  for(let i=13;i>=0;i--){const d=new Date(today);d.setUTCDate(today.getUTCDate()-i);const day=d.toISOString().slice(0,10);days.push({day,count:0});}
  const lookup=Object.fromEntries((activity||[]).map(a=>[a.day,Number(a.count||0)]));days.forEach(d=>d.count=lookup[d.day]||0);
  const max=Math.max(1,...days.map(x=>x.count));
  for(let i=0;i<days.length;i++){const d=days[i];const b=el('div',`activity-bar${i===days.length-1?' today':''}`);b.style.height=`${Math.max(4,Math.round(70*d.count/max))}px`;b.title=`${d.day}: ${fmtNumber(d.count)} events`;b.setAttribute('aria-label',b.title);c.append(b);}
  $('events-seven-days').textContent=fmtNumber((activity||[]).reduce((n,x)=>n+Number(x.count||0),0));
}
function workflowCell(job) {
  const wrap=el('div','workflow-name');append(wrap,el('span','workflow-mini-icon','◈'));
  const copy=el('div');append(copy,el('strong','',job.title||'Untitled workflow'),el('small','',compactId(job.job_id,22)));copy.lastChild.title=job.job_id||'';wrap.append(copy);return wrap;
}
function taskCountCell(job) {
  const running=Number(job.task_running||0), total=Number(job.task_total||0), completed=Number(job.task_completed||0), failed=Number(job.task_failed||0);
  const n=el('span','tasks-cell');n.append(document.createTextNode(`${completed}`),el('i','', '/'),document.createTextNode(`${total}`));
  if(running) n.append(el('i','',` · ${running} running`)); if(failed) n.append(el('i','',` · ${failed} failed`));return n;
}
function taskRoleLabel(task) {
  if (task?.role_display) return task.role_display;
  const custom = task?.custom_role || (task?.metadata && typeof task.metadata.custom_role_id === 'string' ? {
    name: task.metadata.custom_role_name || task.metadata.custom_role_id,
    role_id: task.metadata.custom_role_id,
    version: task.metadata.custom_role_version
  } : null);
  return custom ? `${custom.name || custom.role_id} (${custom.role_id}@${custom.version ?? '?'})` : (task?.role || 'unknown role');
}
function renderRecentJobs(items) {
  const body=$('recent-jobs');clear(body);
  if(!items?.length){const tr=el('tr');const td=el('td','table-empty','No workflows found in the local database.');td.colSpan=5;tr.append(td);body.append(tr);return;}
  for(const j of items.slice(0,7)){const tr=el('tr');tr.tabIndex=0;tr.setAttribute('aria-label',`Inspect workflow ${j.title}`);tr.addEventListener('click',()=>openJob(j.job_id));tr.addEventListener('keydown',e=>{if(e.key==='Enter')openJob(j.job_id)});append(tr,el('td','',undefined),el('td'),el('td'),el('td'),el('td','',undefined));tr.children[0].append(workflowCell(j));tr.children[1].append(el('span','phase-label',String(j.phase||j.state||'—').replaceAll('_',' ')));tr.children[2].append(taskCountCell(j));tr.children[3].append(pill(j.status));tr.children[4].append(relativeTime(j.updated_at));body.append(tr);}
}
function renderStatusBreakdown(o) {
  const target=$('status-breakdown');clear(target);
  const statuses=[['Active',getJobStatusCount(o,'active')],['Completed',getJobStatusCount(o,'completed')],['Failed',getJobStatusCount(o,'failed')]];
  for(const [name,count] of statuses){const item=el('div','breakdown-item');append(item,el('strong','',fmtNumber(count)),el('span','',name));target.append(item);}
}
function renderPhaseBars(phases) {
  const target=$('phase-bars');clear(target); const list=(phases||[]).slice(0,5);const max=Math.max(1,...list.map(x=>Number(x.count||0)));
  if(!list.length){target.append(el('div','muted','No runtime phases recorded.'));return;}
  for(const p of list){const row=el('div','phase-bar-row');const label=el('label','',String(p.name||'unknown').replaceAll('_',' ').toLowerCase());label.title=p.name||'';const track=el('div','phase-track');const fill=el('div','phase-fill');fill.style.width=`${Math.max(3,100*Number(p.count||0)/max)}%`;track.append(fill);append(row,label,track,el('b','',fmtNumber(p.count)));target.append(row);}
}
function eventIcon(type) {const t=String(type||'').toLowerCase();if(/fail|error|reject|block|timeout/.test(t))return ['!','red'];if(/artifact|result|report|review/.test(t))return ['▧','violet'];if(/approval|dispatch|start|complete|phase|task/.test(t))return ['↗',''];if(/security|access|intervention/.test(t))return ['⌑','amber'];return ['≋',''];}
function renderEventRow(evt, compact=false) {
  const [glyph,color]=eventIcon(evt.type);const row=el('div',compact?'event-row':'stream-event');if(!compact){row.tabIndex=0;row.setAttribute('role','button');row.setAttribute('aria-label',`Inspect event ${evt.type||'event'}`);}
  const icon=el('span',`event-icon ${color}`,glyph);const main=el('div',compact?'event-main':'stream-body');
  append(main,el('div',compact?'event-title':'stream-event-head',undefined));
  if(compact){main.firstChild.textContent=evt.type||'event';const sub=el('div','event-sub');append(sub,el('code','',compactId(evt.job_id,18)),el('span','',ago(evt.created_at)));main.append(sub);row.append(icon,main,el('time','event-time',ago(evt.created_at)));}
  else {const head=main.firstChild;head.append(el('strong','',evt.type||'event'),el('time','',dateTime(evt.created_at)));const meta=el('div','stream-event-meta');append(meta,el('span','', 'JOB'),el('code','',compactId(evt.job_id,20)),el('span','',`ID ${compactId(evt.event_id,17)}`));main.append(meta);const rail=el('div','stream-rail');rail.append(el('span'));rail.append(el('i'));append(row,rail,main);row.addEventListener('click',()=>inspectEvent(evt));row.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();inspectEvent(evt)}});}
  return row;
}
function renderLatestEvents(events) {const target=$('latest-events');clear(target);if(!events?.length){target.append(el('div','table-empty','No events recorded yet.'));return;}for(const evt of events.slice(0,5))target.append(renderEventRow(evt,true));}
function renderInventory(counts) {
  const target=$('inventory-list');clear(target);const rows=[['Tasks','Completed task records','⌘',counts.tasks],['Results','Persisted role outputs','◉',counts.results],['Reports','Synthesis and review reports','▤',counts.reports],['Approvals','Explicit decisions','✓',counts.approvals]];
  for(const [name,desc,glyph,count] of rows){const row=el('div','inventory-row');append(row,el('span','inventory-glyph',glyph));const c=el('div','inventory-copy');append(c,el('strong','',name),el('span','',desc));append(row,c,el('strong','inventory-value',fmtNumber(count)));target.append(row);}
}
function renderAttentionList(filter=state.attentionFilter) {
  state.attentionFilter=filter;const target=$('attention-list');if(!target)return;clear(target);
  const jobs=state.attentionJobs||[];const seen=new Set();let candidates=[];
  if(filter==='failed')candidates=jobs.filter(isFailedJob);
  else if(filter==='stale')candidates=jobs.filter(j=>isStaleJob(j));
  else if(filter==='pinned')candidates=jobs.filter(j=>state.pinnedJobs.has(j.job_id));
  else candidates=jobs.filter(j=>isFailedJob(j)||isStaleJob(j)||state.pinnedJobs.has(j.job_id));
  candidates.sort((a,b)=>{
    const rank=j=>isFailedJob(j)?0:isStaleJob(j)?1:2;
    const d=rank(a)-rank(b);if(d)return d;
    return (Date.parse(b.updated_at||'')||0)-(Date.parse(a.updated_at||'')||0);
  });
  candidates=candidates.filter(j=>{if(!j.job_id||seen.has(j.job_id))return false;seen.add(j.job_id);return true;});
  const candidateCount=candidates.length;candidates=candidates.slice(0,6);
  $('attention-count').textContent=fmtNumber(candidateCount);
  const summary=$('attention-summary');if(summary)summary.textContent=candidateCount>candidates.length?`Showing ${candidates.length} of ${fmtNumber(candidateCount)}. `:'';
  document.querySelectorAll('[data-attention-filter]').forEach(b=>b.classList.toggle('selected',b.dataset.attentionFilter===filter));
  if(!candidates.length){const empty=el('div','attention-empty',filter==='pinned'?'No pinned workflows in this tab yet.':filter==='failed'?'No failed workflows in the recent snapshot.':filter==='stale'?'No active workflows have been quiet for more than 15 minutes.':'All clear — no failures or quiet active workflows in the recent snapshot.');target.append(empty);return;}
  for(const job of candidates){
    const row=el('div',`attention-item${isFailedJob(job)?' needs-error':isStaleJob(job)?' needs-stale':''}`);row.tabIndex=0;row.setAttribute('role','button');row.setAttribute('aria-label',`Inspect ${job.title||job.job_id}`);
    const marker=el('span',`attention-marker ${isFailedJob(job)?'error':isStaleJob(job)?'stale':'pinned'}`,isFailedJob(job)?'!':isStaleJob(job)?'◷':'★');
    const main=el('div','attention-main');append(main,el('strong','',job.title||'Untitled workflow'));
    const meta=el('div','attention-meta');append(meta,pill(job.status||job.state),el('span','',isFailedJob(job)?'Needs investigation':isStaleJob(job)?`Quiet ${ago(job.updated_at)}`:'Pinned for this session'),relativeTime(job.updated_at));main.append(meta);
    const actions=el('div','attention-actions');append(actions,copyButton(job.job_id,'Copy ID'),pinButton(job));append(row,marker,main,actions);
    row.addEventListener('click',()=>openJob(job.job_id));row.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openJob(job.job_id);}});target.append(row);
  }
}
function renderOverview() {
  if(!state.overview)return;const o=state.overview, c=o.counts||{};
  setCountsText('metric-jobs',c.jobs);setCountsText('metric-active',getTaskStatusCount(o,'running'));setCountsText('metric-events',c.events);setCountsText('metric-artifacts',c.artifacts);
  $('metric-jobs-foot').textContent=`${fmtNumber(getJobStatusCount(o,'active'))} active · ${fmtNumber(getJobStatusCount(o,'failed'))} failed`;
  $('metric-active-foot').textContent=`${fmtNumber(getTaskStatusCount(o,'pending'))} queued · ${fmtNumber(getTaskStatusCount(o,'completed'))} completed`;
  $('metric-artifact-foot').textContent=`${fmtNumber(c.results)} results · ${fmtNumber(c.reports)} reports`;
  updateSparks(o.activity);renderActivityChart(o.activity);renderStatusBreakdown(o);renderPhaseBars(o.phases);renderLatestEvents(o.recent_events);renderInventory(c);renderAttentionList();
  if(state.view==='overview')loadJobs(true).catch(()=>{});
}
async function loadAttentionSnapshot() {
  const snapshot=await api('/api/jobs?limit=100&offset=0');
  const rows=snapshot.items||[];const known=new Set(rows.map(job=>job.job_id));
  const missing=[...state.pinnedJobs].filter(id=>!known.has(id)).slice(0,20);
  const pinned=await Promise.all(missing.map(async id=>{try{const detail=await api(`/api/jobs/${encodeURIComponent(id)}`);return detail.job||null;}catch{return null;}}));
  state.attentionJobs=[...rows,...pinned.filter(Boolean)];
}
async function refreshOverview() {
  try {
    const [health,overview]=await Promise.all([api('/api/health'),api('/api/overview')]);state.overview=overview;state.lastSync=new Date();
    try { await loadAttentionSnapshot(); } catch {}
    $('top-health').textContent='Connected · read-only';$('runtime-status-title').textContent='Database connected';$('runtime-status-caption').textContent='Read-only SQLite';$('runtime-mode').textContent='LOCAL';$('runtime-mode').className='status-pill status-live';$('footer-clock').textContent=dateTime(state.lastSync.toISOString());$('last-updated').textContent=`UPDATED ${state.lastSync.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;$('last-updated').title=`Last successful refresh: ${dateTime(state.lastSync.toISOString())} · auto-refresh every 20s`;
    $('nav-jobs-count').textContent=fmtNumber(overview.counts?.jobs);$('nav-events-count').textContent=fmtNumber(overview.counts?.events);$('nav-roles-count').textContent=fmtNumber(overview.counts?.custom_profiles);$('nav-batches-count').textContent=fmtNumber(overview.counts?.batches);setBanner('');renderOverview();return true;
  } catch(error) {
    $('top-health').textContent='Disconnected';$('runtime-status-title').textContent='Local database unavailable';$('runtime-status-caption').textContent='Check plugin path and permissions';$('runtime-mode').textContent='OFFLINE';$('runtime-mode').className='status-pill status-failed';setBanner(`Cannot refresh the local database: ${error.message}. The last successful snapshot, if present, is retained.`);return false;
  }
}
function setViewPlaceholder(body, span, text) {clear(body);const tr=el('tr');const td=el('td','table-empty',text);td.colSpan=span;tr.append(td);body.append(tr);}
function renderJobsTable(items, body, onOpen, mode='all') {
  clear(body);if(mode==='all'){$('workflow-results-meta').textContent=`${fmtNumber(state.jobTotal)} workflows${state.jobQuery?' · search applied':''}${state.statusFilter?' · '+state.statusFilter:''}${state.phaseFilter?' · '+state.phaseFilter.replaceAll('_',' '):''}`;document.querySelectorAll('[data-quick-status]').forEach(b=>b.classList.toggle('selected',b.dataset.quickStatus===state.statusFilter));}if(!items?.length){const tr=el('tr'),td=el('td','table-empty','No matching workflows.');td.colSpan=mode==='all'?7:5;tr.append(td);body.append(tr);return;}
  for(const job of items){const tr=el('tr');tr.tabIndex=0;tr.addEventListener('click',()=>onOpen(job.job_id));tr.addEventListener('keydown',e=>{if(e.key==='Enter')onOpen(job.job_id)});
    if(mode==='all'){
      const td1=el('td');td1.append(workflowCell(job));
      const progress=el('div','progress-cell');const sum=el('div','progress-summary');append(sum,el('span','',`${job.task_completed||0} / ${job.task_total||0} complete`),el('b','',`${job.task_total?Math.round(100*job.task_completed/job.task_total):0}%`));const track=el('div','progress-track'),fill=el('i');fill.style.width=`${job.task_total?Math.round(100*job.task_completed/job.task_total):0}%`;track.append(fill);progress.append(sum,track);
      const statusTd=el('td');statusTd.append(pill(job.status));
      const phaseTd=el('td');phaseTd.append(el('span','phase-label',String(job.phase||job.state||'—').replaceAll('_',' ')));const progressTd=el('td');progressTd.append(progress);
      const actions=el('div','row-actions');append(actions,copyButton(job.job_id,'Copy ID'),pinButton(job));
      const eventsTd=el('td','',fmtNumber(job.event_total));const updatedTd=el('td');updatedTd.append(relativeTime(job.updated_at));const actionsTd=el('td');actionsTd.append(actions);
      append(tr,td1,statusTd,phaseTd,progressTd,eventsTd,updatedTd,actionsTd);
    }else{const td=el('td');td.append(workflowCell(job));const phaseTd=el('td');phaseTd.append(el('span','phase-label',String(job.phase||job.state||'—').replaceAll('_',' ')));const tasksTd=el('td');tasksTd.append(taskCountCell(job));const statusTd=el('td');statusTd.append(pill(job.status));append(tr,td,phaseTd,tasksTd,statusTd,el('td','',ago(job.updated_at)));}
    body.append(tr);
  }
}
function renderPagination(targetId,{total,offset,limit,onPrev,onNext}) {
  const target=$(targetId);clear(target);append(target,el('span','',`${total?offset+1:0}–${Math.min(total,offset+limit)} of ${fmtNumber(total)} records`));const actions=el('div');const prev=el('button','','← Previous');prev.disabled=offset<=0;prev.addEventListener('click',onPrev);const next=el('button','','Next →');next.disabled=offset+limit>=total;next.style.marginLeft='7px';next.addEventListener('click',onNext);append(actions,prev,next);target.append(actions);
}
async function loadJobs(quiet=false) {
  try{const overviewMode=state.view==='overview';const params=new URLSearchParams({q:overviewMode?'':state.jobQuery,status:overviewMode?'':state.statusFilter,phase:overviewMode?'':state.phaseFilter,limit:String(overviewMode?7:state.jobLimit),offset:String(overviewMode?0:state.jobOffset)});const data=await api(`/api/jobs?${params}`);state.jobs=data.items||[];state.jobTotal=data.total||0;if(state.overview&&overviewMode)renderRecentJobs(state.jobs);if(state.view==='workflows'){
    renderJobsTable(state.jobs,$('all-jobs'),openJob,'all');renderPagination('jobs-pagination',{total:state.jobTotal,offset:state.jobOffset,limit:state.jobLimit,onPrev:()=>{state.jobOffset=Math.max(0,state.jobOffset-state.jobLimit);loadJobs()},onNext:()=>{state.jobOffset+=state.jobLimit;loadJobs()}});
    const select=$('workflow-phase-filter');const prior=state.phaseFilter||select.value;const phases=[...new Set((state.overview?.phases||[]).map(p=>p.name).filter(Boolean))];clear(select);select.append(el('option','','All phases'));select.firstChild.value='';for(const p of phases){const opt=el('option','',p.replaceAll('_',' '));opt.value=p;select.append(opt)}select.value=phases.includes(prior)?prior:'';state.phaseFilter=select.value;if(state.phaseFilter!==prior)saveSessionPrefs();
  }}catch(error){if(!quiet)notify(`Unable to load workflows: ${error.message}`,true);}
}
async function openJob(jobId) {
  try{const data=await api(`/api/jobs/${encodeURIComponent(jobId)}`);setView('workflows');state.currentJob=data;state.jobTab='tasks';renderJobDetail();}catch(error){notify(`Unable to inspect job: ${error.message}`,true);}
}
function goBackToJobs(){state.currentJob=null;loadJobs();}
function makeFact(label,value){const box=el('div','panel');append(box,el('div','fact-label',label),el('div','fact-value',value));return box;}
function makeTable(headers, rows, emptyText='No records available.') {
  const wrap=el('div','table-wrap'),table=el('table','data-table'),thead=el('thead'),tr=el('tr');for(const h of headers)tr.append(el('th','',h));thead.append(tr);const tbody=el('tbody');
  if(!rows.length){const empty=el('tr'),td=el('td','table-empty',emptyText);td.colSpan=headers.length;empty.append(td);tbody.append(empty)}else for(const values of rows){const row=el('tr');for(const v of values){const td=el('td');if(v instanceof Node)td.append(v);else td.textContent=v==null?'—':String(v);row.append(td)}tbody.append(row)}table.append(thead,tbody);wrap.append(table);return wrap;
}
function blockText(label,value) {const box=el('details','payload-block');const summary=el('summary','payload-label',label);const pre=el('pre','payload-pre',typeof value==='string'?value:JSON.stringify(value,null,2));box.append(summary,pre);return box;}
function renderJobDetail() {
  const data=state.currentJob;if(!data)return;const job=data.job;
  const host=$('workflows-view');let detail=$('job-detail-shell');if(!detail){detail=el('div');detail.id='job-detail-shell';host.prepend(detail)}clear(detail);$('workflows-view').querySelector('.section-toolbar')?.classList.add('hidden');$('workflows-view').querySelector('.filter-rail')?.classList.add('hidden');$('workflows-view').querySelector('.table-panel')?.classList.add('hidden');
  const back=el('button','small-button job-detail-back','← Back to workflow registry');back.addEventListener('click',()=>{detail.remove();$('workflows-view').querySelector('.section-toolbar')?.classList.remove('hidden');$('workflows-view').querySelector('.filter-rail')?.classList.remove('hidden');$('workflows-view').querySelector('.table-panel')?.classList.remove('hidden');goBackToJobs()});detail.append(back);
  const header=el('div','job-detail-header'),left=el('div');append(left,el('h2','',job.title||'Untitled workflow'),el('p','mono',job.job_id),el('p','',`Created ${dateTime(job.created_at)} · Updated ${dateTime(job.updated_at)}`),copyButton(job.job_id,'Copy ID'),pinButton(job));append(header,left,pill(job.status));detail.append(header);
  const grid=el('div','job-detail-grid');append(grid,makeFact('RUNTIME PHASE',String(job.phase||job.state||'—').replaceAll('_',' ')),makeFact('TASKS',`${data.tasks.filter(t=>t.status==='completed').length} / ${data.tasks.length} completed`),makeFact('DURABLE EVENTS',fmtNumber(data.events.length)));detail.append(grid);
  const tabs=el('div','job-tabs');const counts={tasks:data.tasks.length,approvals:data.approvals.length,attempts:data.attempts.length,results:data.results.length,artifacts:data.artifacts.length,reports:data.reports.length,events:data.events.length,transitions:data.transitions.length,executions:data.batches.length};for(const tab of Object.keys(counts)){const b=el('button',`job-tab${state.jobTab===tab?' active':''}`,`${tab[0].toUpperCase()+tab.slice(1)} · ${counts[tab]}`);b.addEventListener('click',()=>{state.jobTab=tab;renderJobDetail()});tabs.append(b)}detail.append(tabs);
  const body=el('div','panel job-subpanel');
  if(state.jobTab==='tasks'){
    const rows=data.tasks.map(t=>[el('span','mono',compactId(t.task_id,20)),taskRoleLabel(t),pill(t.status),Array.isArray(t.dependency)?t.dependency.join(', '):boundedString(t.dependency_json),t.execution_exit_code==null?'—':String(t.execution_exit_code),ago(t.updated_at)]);body.append(makeTable(['TASK ID','ROLE / PROFILE','STATUS','DEPENDENCIES','EXIT','UPDATED'],rows));
    for(const t of data.tasks){const item=el('div','detail-list-item');append(item,el('strong','',`${taskRoleLabel(t)} · ${t.status}`),el('small','mono',t.task_id),el('p','',t.description||''));if(t.execution_stderr)item.append(blockText('STDERR',t.execution_stderr));if(t.execution_stdout)item.append(blockText('STDOUT',t.execution_stdout));body.append(item)}
  } else if(state.jobTab==='approvals') body.append(makeTable(['DECISION','ACTOR','TIMESTAMP','PLAN HASH','DETAIL'],data.approvals.map(a=>[pill(a.decision),a.actor, dateTime(a.created_at),compactId(a.proposal_hash,18),a.raw_text])));
  else if(state.jobTab==='attempts') body.append(makeTable(['ROLE / PROFILE','STATUS','STARTED','FINISHED','ERROR'],data.attempts.map(a=>[taskRoleLabel(data.tasks.find(t=>t.task_id===a.task_id)||{role:a.role}),pill(a.status),dateTime(a.started_at),dateTime(a.finished_at),a.error])));
  else if(state.jobTab==='results') for(const r of data.results){const item=el('div','detail-list-item');append(item,el('strong','',`${taskRoleLabel(data.tasks.find(t=>t.task_id===r.task_id)||{role:r.role})} · ${r.outcome}`),el('small','mono',r.result_id),el('small','',dateTime(r.created_at)),blockText('RESULT CONTENT',r.content));body.append(item)}
  else if(state.jobTab==='artifacts') for(const a of data.artifacts){const row=el('div','detail-list-item');append(row,el('strong','',`${a.type||'artifact'} · ${a.status||'unknown'}`),el('small','mono',a.artifact_id),el('small','',`Producer ${a.producer_role||'unknown'} · hash ${a.content_hash||'—'}`));const b=el('button','inspector-link','Inspect artifact');b.addEventListener('click',()=>{state.selectedArtifact=a.artifact_id;setView('artifacts');loadArtifacts().then(()=>inspectArtifact(a.artifact_id))});row.append(b);body.append(row)}
  else if(state.jobTab==='reports')for(const r of data.reports){const item=el('div','detail-list-item');append(item,el('strong','',r.kind||'report'),el('small','',dateTime(r.created_at)),blockText('REPORT CONTENT',r.content));body.append(item)}
  else if(state.jobTab==='events')for(const e of data.events)body.append(eventDetailCard(e));
  else if(state.jobTab==='transitions')body.append(makeTable(['FROM','TO','EVENT','ATTEMPT','TIME'],data.transitions.map(e=>[e.from_phase||'—',e.to_phase||'—',e.type||'—',e.attempt??'—',dateTime(e.created_at)])));
  else if(state.jobTab==='executions'){if(!data.batches.length)body.append(el('div','table-empty','No durable batch record exists for this workflow. Specialist roles run as individual tasks unless an authorized execute_batch call groups deterministic local tasks.'));for(const b of data.batches){const item=el('div','detail-list-item');append(item,el('strong','',`${b.role} · ${b.status}`),el('small','mono',b.batch_id),el('small','',`${b.items?.length||0} execution items · attempt ${b.attempt}`));if(b.aggregate_content)item.append(blockText('AGGREGATE OUTPUT',b.aggregate_content));for(const i of b.items||[]){append(item,el('p','mono',`$ ${i.command}`),el('small','',`status ${i.status} · exit ${i.exit_code??'—'} · cwd ${i.cwd||'—'}`));if(i.stdout)item.append(blockText('STDOUT',i.stdout));if(i.stderr)item.append(blockText('STDERR',i.stderr));if(i.error)item.append(blockText('ERROR',i.error))}body.append(item)}}
  detail.append(body);window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
}
function boundedString(v){return typeof v==='string'?v:JSON.stringify(v??'—')}
function eventDetailCard(evt){const card=el('div','detail-list-item');append(card,el('strong','',evt.type||'event'),el('small','mono',evt.event_id||evt.workflow_event_id),el('small','',dateTime(evt.created_at)),blockText('PAYLOAD',evt.payload));return card}
async function loadEvents() {
  try{const q=$('event-search').value;state.eventQuery=q;state.eventType=$('event-type-filter').value;const params=new URLSearchParams({q,type:state.eventType,limit:String(state.eventLimit),offset:String(state.eventOffset)});const data=await api(`/api/events?${params}`);state.events=data.items||[];state.eventTotal=data.total||0;$('event-total').textContent=`${fmtNumber(data.total)} records`;const target=$('event-stream');clear(target);if(!state.events.length)target.append(el('div','table-empty','No events match these filters.'));else for(const e of state.events)target.append(renderEventRow(e,false));renderPagination('events-pagination',{total:state.eventTotal,offset:state.eventOffset,limit:state.eventLimit,onPrev:()=>{state.eventOffset=Math.max(0,state.eventOffset-state.eventLimit);loadEvents()},onNext:()=>{state.eventOffset+=state.eventLimit;loadEvents()}});
    const typeSel=$('event-type-filter'),prior=typeSel.value;if(typeSel.options.length<=1){const types=[...new Set(state.events.map(e=>e.type).filter(Boolean))];for(const t of types){const opt=el('option','',t);opt.value=t;typeSel.append(opt)}typeSel.value=prior;}
  }catch(error){notify(`Unable to load events: ${error.message}`,true)}
}
function inspectEvent(evt) {
  state.selectedEvent=evt;const target=$('event-inspector');clear(target);target.className='';append(target,el('div','detail-fact',`Event ID: ${evt.event_id||evt.workflow_event_id}`),el('div','detail-fact',`Job: ${evt.job_id}`),el('div','detail-fact',`Time: ${dateTime(evt.created_at)}`),copyButton(evt.event_id||evt.workflow_event_id,'Copy event ID'),copyButton(evt.job_id,'Copy job ID'),blockText('EVENT TYPE',evt.type),blockText('PAYLOAD',evt.payload));const button=el('button','inspector-link','Open source workflow');button.addEventListener('click',()=>openJob(evt.job_id));target.append(button);
}
async function loadArtifacts() {
  try{state.artifactQuery=$('artifact-search').value;state.artifactType=$('artifact-type-filter').value;const params=new URLSearchParams({q:state.artifactQuery,type:state.artifactType,limit:String(state.artifactLimit),offset:String(state.artifactOffset)});const data=await api(`/api/artifacts?${params}`);state.artifacts=data.items||[];state.artifactTotal=data.total||0;const grid=$('artifact-grid');clear(grid);if(!state.artifacts.length)grid.append(el('div','table-empty','No artifacts match this filter.'));for(const a of state.artifacts){const b=el('button',`artifact-card${state.selectedArtifact===a.artifact_id?' selected':''}`);const head=el('div','artifact-card-head');append(head,el('span','artifact-glyph','▧'));const title=el('div','artifact-card-title');append(title,el('strong','',a.type||'Artifact'),el('small','',`${a.producer_role||'unknown producer'} · schema ${a.schema_version??'—'}`));head.append(title);b.append(head,el('p','mono',compactId(a.artifact_id,30)));const foot=el('div','artifact-card-foot');foot.append(pill(a.status||'unknown'),el('span','hash-short',a.content_hash?`${a.content_hash.slice(0,10)}…`:'no hash'));b.append(foot);b.addEventListener('click',()=>inspectArtifact(a.artifact_id));grid.append(b)}renderPagination('artifacts-pagination',{total:state.artifactTotal,offset:state.artifactOffset,limit:state.artifactLimit,onPrev:()=>{state.artifactOffset=Math.max(0,state.artifactOffset-state.artifactLimit);loadArtifacts()},onNext:()=>{state.artifactOffset+=state.artifactLimit;loadArtifacts()}});
    const typeSel=$('artifact-type-filter'),prior=typeSel.value;if(typeSel.options.length<=1){const types=[...new Set(state.artifacts.map(a=>a.type).filter(Boolean))];for(const t of types){const opt=el('option','',t);opt.value=t;typeSel.append(opt)}typeSel.value=prior;}
    if(state.selectedArtifact)await inspectArtifact(state.selectedArtifact,false);
  }catch(error){notify(`Unable to load artifacts: ${error.message}`,true)}
}
async function inspectArtifact(id, updateSelection=true) {
  try{const a=await api(`/api/artifacts/${encodeURIComponent(id)}`);if(updateSelection)state.selectedArtifact=id;const target=$('artifact-inspector-body');clear(target);target.className='';$('artifact-inspector-title').textContent=a.type||'Artifact';$('artifact-inspector-subtitle').textContent=`${a.producer_role||'Unknown producer'} · ${dateTime(a.created_at)}`;
    const facts=el('div','detail-facts');for(const [k,v] of [['STATUS',a.status],['SCHEMA',a.schema_version],['CONTENT SIZE',`${fmtNumber(a.content_length)} chars`],['HASH',a.content_hash?`${a.content_hash.slice(0,15)}…`:'not recorded']]){const box=el('div','detail-fact');append(box,el('span','',k),el('strong','',v??'—'));facts.append(box)}target.append(facts,copyButton(a.artifact_id,'Copy artifact ID'),blockText('ARTIFACT ID',a.artifact_id),blockText('JOB / TASK',`${a.job_id}\n${a.task_id||'no task id'}`),blockText('EVIDENCE REFERENCES',a.evidence??'Not recorded'),blockText('CONTENT',a.content_malformed?a.content_preview:a.content));if(a.content_truncated)target.append(el('div','danger-note','Content preview is truncated. Original content remains unchanged in the local SQLite store.'));const button=el('button','inspector-link','Open source workflow');button.addEventListener('click',()=>openJob(a.job_id));target.append(button);document.querySelectorAll('.artifact-card').forEach(c=>c.classList.toggle('selected',c.querySelector('.mono')?.textContent===compactId(id,30)));
  }catch(error){notify(`Unable to inspect artifact: ${error.message}`,true)}
}
function roleKey(role) { return `${role?.role_id || ''}@${role?.version ?? ''}`; }
function renderRegistrySummary(targetId, values) {
  const target=$(targetId);clear(target);
  for(const [label,value,detail=''] of values){const card=el('div','registry-stat');append(card,el('span','registry-stat-label',label),el('strong','',fmtNumber(value)),detail?el('small','',detail):null);target.append(card);}
}
function inspectRole(role) {
  if(!role)return;state.selectedRoleKey=roleKey(role);
  const target=$('role-inspector-body');clear(target);target.className='role-inspector-body';
  $('role-inspector-title').textContent=role.name||role.role_id;
  $('role-inspector-subtitle').textContent=`${role.role_id}@${role.version} · created ${dateTime(role.created_at)}`;
  append(target,el('p','registry-description',role.description||'No description recorded.'));
  const facts=el('div','detail-facts');
  for(const [label,value] of [['ROLE ID',role.role_id],['VERSION',role.version],['OUTPUT',role.output_artifact_type],['CREATED BY',role.created_by]]){const box=el('div','detail-fact');append(box,el('span','',label),el('strong','',value??'—'));facts.append(box);}
  target.append(facts);
  const addList=(title,values)=>{const section=el('section','role-detail-section');section.append(el('h4','',title));const body=el('div','role-token-list');const entries=Array.isArray(values)?values:[];if(!entries.length)body.append(el('span','registry-muted','None declared'));else for(const value of entries)body.append(el('span','role-token',value));section.append(body);target.append(section);};
  addList('Accepted input artifacts',role.input_contract);addList('Declared capabilities',role.allowed_capabilities);addList('Permissions',role.permissions);addList('Allowed read-only tools',role.allowed_tools);
  const section=el('section','role-detail-section');append(section,el('h4','',`Attached Agent Skills · ${(role.skills||[]).length}`));
  if(!role.skills?.length)section.append(el('div','role-empty-note','No skill snapshot attached to this role version.'));
  for(const skill of role.skills||[]){
    const card=el('article','role-skill-card');append(card,el('strong','',skill.name||'Unnamed skill'),el('p','',skill.description||'No skill description recorded.'),el('small','',skill.source||'Unknown source'),el('small','mono',`SHA-256 ${skill.sha256||'not recorded'}`),el('small','',`${skill.supporting_files??0} supporting files · ${fmtNumber(skill.instruction_chars||0)} instruction characters`));
    if(skill.instructions_preview)card.append(blockText('SNAPSHOTTED SKILL INSTRUCTIONS',skill.instructions_preview));
    if(skill.files?.length)card.append(blockText('SUPPORTING FILE HASHES',skill.files.map(file=>({path:file.path,sha256:file.sha256,size_bytes:file.size_bytes}))));
    section.append(card);
  }
  target.append(section,blockText('SYSTEM PROMPT',role.system_prompt||''));
  document.querySelectorAll('#role-list tr[data-role-key]').forEach(row=>row.classList.toggle('selected',row.dataset.roleKey===state.selectedRoleKey));
}
async function inspectPinnedRole(roleId,version) {
  try{
    const data=await api(`/api/roles?versions=all&q=${encodeURIComponent(roleId)}&limit=200`);
    const role=(data.custom_roles||[]).find(item=>item.role_id===roleId&&Number(item.version)===Number(version));
    if(!role){$('role-search').value=roleId;state.roleVersions='all';$('role-version-filter').value='all';await loadRoles(true);notify(`Pinned role version ${roleId}@${version} is not available in the registry snapshot.`,true);return;}
    state.roleVersions='all';$('role-version-filter').value='all';state.selectedRoleKey=roleKey(role);await loadRoles(true);inspectRole(role);
  }catch(error){notify(`Unable to inspect pinned role: ${error.message}`,true);}
}
async function loadRoles(quiet=false) {
  try{
    state.roleQuery=$('role-search').value.trim();state.roleVersions=$('role-version-filter').value||'latest';
    const params=new URLSearchParams({q:state.roleQuery,versions:state.roleVersions,limit:'200'});
    const data=await api(`/api/roles?${params}`);state.roles=data;
    const summary=data.summary||{};
    $('nav-roles-count').textContent=fmtNumber(summary.custom_profiles||0);
    renderRegistrySummary('role-summary',[
      ['Built-in role IDs',summary.built_in_role_ids||0,'Fixed runtime contracts'],
      ['Custom profiles',summary.custom_profiles||0,'Saved role identities'],
      ['Stored versions',summary.custom_role_versions||0,'Immutable versions'],
      ['Attached skills',summary.attached_skills||0,'Latest version snapshots'],
      ['Custom workflows',summary.custom_workflows||0,'Role pins per task'],
      ['Built-in overlays',summary.builtin_profile_pins||0,'Proposal-pinned profiles']
    ]);
    $('role-list-caption').textContent=`${(data.custom_roles||[]).length} profile versions shown · ${state.roleVersions==='all'?'all versions':'latest version per profile'}`;
    const rolesBody=$('role-list');clear(rolesBody);
    if(!data.custom_roles?.length){const tr=el('tr'),td=el('td','table-empty','No custom role profile matches this filter. Built-in roles remain fixed runtime contracts.');td.colSpan=4;tr.append(td);rolesBody.append(tr);}
    for(const role of data.custom_roles||[]){
      const tr=el('tr');tr.dataset.roleKey=roleKey(role);tr.classList.toggle('selected',tr.dataset.roleKey===state.selectedRoleKey);tr.tabIndex=0;
      const title=el('td');const button=el('button','role-select-button');append(button,el('strong','',role.name),el('small','mono',role.role_id));button.addEventListener('click',()=>inspectRole(role));tr.addEventListener('keydown',e=>{if(e.key==='Enter')inspectRole(role)});title.append(button);
      const version=el('td','mono',`v${role.version}`);const output=el('td','',role.output_artifact_type||'—');const skills=el('td');const count=(role.skills||[]).length;skills.append(el('span',`status-pill ${count?'status-completed':'status-pending'}`,`${count} skill${count===1?'':'s'}`));append(tr,title,version,output,skills);rolesBody.append(tr);
    }
    const builtins=$('builtin-role-list');clear(builtins);
    if(!data.builtin_roles?.length){const tr=el('tr'),td=el('td','table-empty','No built-in role IDs found in the task ledger.');td.colSpan=3;tr.append(td);builtins.append(tr);}
    for(const role of data.builtin_roles||[]){const tr=el('tr');append(tr,el('td','mono',role.role),el('td','',fmtNumber(role.task_count)),el('td','',fmtNumber(role.job_count)));builtins.append(tr);}
    const pins=$('role-workflow-list');clear(pins);const pinRows=(data.custom_workflows||[]).flatMap(workflow=>(workflow.tasks||[]).map(task=>({workflow,task})));
    if(!pinRows.length){const tr=el('tr'),td=el('td','table-empty','No custom workflow role pins found. Built-in workflows use their fixed specialist contracts.');td.colSpan=5;tr.append(td);pins.append(tr);}
    for(const {workflow,task} of pinRows){const tr=el('tr');const workflowCell=el('td');append(workflowCell,el('strong','',workflow.name),el('small','mono',`${workflow.workflow_id}@${workflow.version}`));const roleCell=el('td');const roleButton=el('button','role-select-button');append(roleButton,el('strong','',task.role_name),el('small','mono',`${task.role_id}@${task.role_version}`));roleButton.addEventListener('click',()=>inspectPinnedRole(task.role_id,task.role_version));append(tr,workflowCell,el('td','mono',task.task_id),roleCell,el('td','',task.output_artifact_type),el('td','',task.skills?.length?task.skills.join(', '):'No skills'));roleCell.append(roleButton);pins.append(tr);}
    const overlayPins=$('builtin-role-profile-pin-list');clear(overlayPins);const overlays=data.builtin_role_profile_pins||[];
    if(!overlays.length){const tr=el('tr'),td=el('td','table-empty','No built-in workflow proposal has pinned a custom profile overlay.');td.colSpan=5;tr.append(td);overlayPins.append(tr);}
    for(const pin of overlays){const tr=el('tr');const workflowCell=el('td');append(workflowCell,el('strong','',pin.workflow_name||pin.job_id),el('small','mono',`${pin.workflow_id} · ${pin.job_id}`),el('small','',`Workflow status: ${pin.workflow_status||'unknown'} · proposal pin; approval/execution not implied`));const roleCell=el('td','mono',pin.built_in_role);const profileCell=el('td');const profileButton=el('button','role-select-button');append(profileButton,el('strong','',pin.role_name),el('small','mono',`${pin.role_id}@${pin.role_version}`));profileButton.addEventListener('click',()=>inspectPinnedRole(pin.role_id,pin.role_version));profileCell.append(profileButton);append(tr,workflowCell,roleCell,profileCell,el('td','mono',pin.profile_hash||'Hash unavailable'),el('td','',pin.skills?.length?pin.skills.join(', '):'No skills'));overlayPins.append(tr);}
    $('role-edit-note').textContent=data.edit_note||'This registry is read-only. Use the custom-role tools to change definitions.';
    const selected=(data.custom_roles||[]).find(role=>roleKey(role)===state.selectedRoleKey);
    if(selected)inspectRole(selected);else if(data.custom_roles?.length)inspectRole(data.custom_roles[0]);else{
      state.selectedRoleKey=null;$('role-inspector-title').textContent='No custom role selected';$('role-inspector-subtitle').textContent='Built-in runtime roles are fixed contracts.';const inspector=$('role-inspector-body');clear(inspector);inspector.className='inspector-placeholder';inspector.append(el('span','', 'Create a custom role through custom_role_create, then pin it into a custom workflow.'));
    }
  }catch(error){if(!quiet)notify(`Unable to load role registry: ${error.message}`,true);}
}
function inspectBatch(batch) {
  if(!batch)return;state.selectedBatchId=batch.batch_id;
  $('batch-inspector-title').textContent=`${batch.role} · ${batch.status}`;
  $('batch-inspector-subtitle').textContent=`${batch.batch_id} · attempt ${batch.attempt}`;
  const target=$('batch-inspector-body');clear(target);target.className='batch-inspector-body';
  const facts=el('div','detail-facts');for(const [label,value] of [['WORKFLOW',batch.job_title||batch.job_id],['ROLE',batch.role],['STATUS',batch.status],['ITEMS',`${batch.completed_items||0}/${batch.item_count||0} completed`],['CREATED',dateTime(batch.created_at)],['STARTED',dateTime(batch.started_at)],['FINISHED',dateTime(batch.finished_at)],['PARENT TASK',batch.parent_task_id||'—']]){const box=el('div','detail-fact');append(box,el('span','',label),el('strong','',value??'—'));facts.append(box);}target.append(facts);
  const openWorkflow=el('button','inspector-link','Open parent workflow');openWorkflow.addEventListener('click',()=>openJob(batch.job_id));target.append(openWorkflow);
  if(batch.aggregate_content)target.append(blockText('AGGREGATE OUTPUT',batch.aggregate_content));
  for(const item of batch.items||[]){const card=el('article','batch-item-card');append(card,el('strong','',`${item.item_id} · ${item.status}`),el('small','mono',item.task_id),el('p','mono',`$ ${item.command}`),el('small','',`Exit ${item.exit_code??'—'} · attempt ${item.attempt} · timeout ${item.timeout_ms??'—'} ms`),el('small','',item.cwd||'Working directory unavailable'));
    if(item.stdout)card.append(blockText('STDOUT',item.stdout));if(item.stderr)card.append(blockText('STDERR',item.stderr));if(item.error)card.append(blockText('ERROR',item.error));target.append(card);
  }
  if(batch.items_truncated)target.append(el('p','registry-footnote',`Showing ${batch.items?.length||0} of ${batch.items_total||0} batch items in this bounded response.`));
  document.querySelectorAll('#batch-list tr[data-batch-id]').forEach(row=>row.classList.toggle('selected',row.dataset.batchId===batch.batch_id));
}
async function openExecutionTask(item) {
  await openJob(item.job_id);
  if(!state.currentJob || state.currentJob.job?.job_id!==item.job_id)return;
  state.jobTab='tasks';renderJobDetail();
  const card=[...document.querySelectorAll('#job-detail-shell .detail-list-item')].find(node=>node.querySelector('small.mono')?.textContent===item.task_id);
  if(!card)return;
  card.classList.add('execution-focus');
  for(const disclosure of card.querySelectorAll('details'))disclosure.open=true;
  card.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
}
async function loadBatches(quiet=false) {
  try{
    state.batchQuery=$('batch-search').value.trim();state.batchStatus=$('batch-status-filter').value;
    const params=new URLSearchParams({q:state.batchQuery,status:state.batchStatus,limit:String(state.batchLimit),offset:String(state.batchOffset),executionLimit:String(state.individualExecutionLimit),executionOffset:String(state.individualExecutionOffset)});
    const data=await api(`/api/batches?${params}`);state.batches=data.items||[];state.batchTotal=Number(data.total||0);
    state.individualExecutions=data.individual_items||[];state.individualExecutionTotal=Number(data.individual_total||0);
    const statuses=mapCount(data.statuses,'status');const individualStatuses=mapCount(data.individual_statuses,'status');
    renderRegistrySummary('batch-summary',[
      ['Durable batches',data.summary?.batches||0,'execution_batches rows'],
      ['Batch items',data.summary?.items||0,'execution_batch_items rows'],
      ['Individual task runs',data.summary?.individual_executions||0,'Not grouped into batches'],
      ['Active batches',(statuses.RUNNING||0)+(statuses.WAITING||0),'Running or waiting'],
      ['Completed task runs',individualStatuses.COMPLETED||0,'ExecutionManager successes'],
      ['Failed task runs',individualStatuses.FAILED||0,'ExecutionManager failures']
    ]);
    $('nav-batches-count').textContent=fmtNumber(data.summary?.batches||0);
    $('batch-list-caption').textContent=`${fmtNumber(data.total)} matching batches · ${fmtNumber(data.summary?.items||0)} recorded items total`;
    $('individual-executions-caption').textContent=`${fmtNumber(data.individual_total)} matching individual task executions · these are real executions, but not batch records`;
    $('batch-empty-explanation').textContent=data.empty_explanation||'A batch exists only after a durable batch execution request.';
    const tbody=$('batch-list');clear(tbody);
    if(!state.batches.length){const tr=el('tr'),td=el('td','table-empty',state.batchQuery||state.batchStatus?'No execution batches match this filter.':'No execution batches have been recorded in the local SQLite database.');td.colSpan=6;tr.append(td);tbody.append(tr);}
    for(const batch of state.batches){const tr=el('tr');tr.tabIndex=0;tr.dataset.batchId=batch.batch_id;tr.classList.toggle('selected',batch.batch_id===state.selectedBatchId);const jobCell=el('td');append(jobCell,el('strong','',batch.job_title||batch.job_id),el('small','mono',compactId(batch.job_id,22)));const items=el('td',`${Number(batch.failed_items||0)?'batch-items-failed':''}`,`${batch.completed_items||0}/${batch.item_count||0}`);if(Number(batch.failed_items||0))items.title=`${batch.failed_items} failed items`;const created=el('td');created.append(relativeTime(batch.created_at));append(tr,jobCell,el('td','',batch.role),el('td','',pill(batch.status)),items,el('td','',batch.attempt),created);tr.addEventListener('click',()=>inspectBatch(batch));tr.addEventListener('keydown',e=>{if(e.key==='Enter')inspectBatch(batch)});tbody.append(tr);}
    renderPagination('batches-pagination',{total:state.batchTotal,offset:state.batchOffset,limit:state.batchLimit,onPrev:()=>{state.batchOffset=Math.max(0,state.batchOffset-state.batchLimit);loadBatches()},onNext:()=>{state.batchOffset+=state.batchLimit;loadBatches()}});
    const executions=$('individual-execution-list');clear(executions);
    if(!state.individualExecutions.length){const tr=el('tr'),td=el('td','table-empty',state.batchQuery||state.batchStatus?'No individual task executions match this filter.':'No individual ExecutionManager runs have been recorded.');td.colSpan=6;tr.append(td);executions.append(tr);}
    for(const item of state.individualExecutions){
      const tr=el('tr');tr.tabIndex=0;tr.dataset.taskId=item.task_id;
      const workflowCell=el('td','execution-job-cell');append(workflowCell,el('strong','',item.job_title||item.job_id),el('small','mono',compactId(item.task_id,22)));
      const roleCell=el('td','execution-role-cell');append(roleCell,el('strong','',item.role_display||item.role),el('small','mono',item.custom_role_id?item.role:'Built-in runtime role'));
      const finished=item.execution_finished_at||item.execution_started_at;
      const finishedCell=el('td');finishedCell.append(finished?relativeTime(finished):el('span','', '—'));
      append(tr,workflowCell,roleCell,pill(item.execution_status||item.task_status),el('td','',item.execution_exit_code==null?'—':String(item.execution_exit_code)),el('td','mono execution-session',compactId(item.execution_session_id||'',18)),finishedCell);
      tr.title='Open this task and its captured output';tr.addEventListener('click',()=>openExecutionTask(item));tr.addEventListener('keydown',e=>{if(e.key==='Enter')openExecutionTask(item)});executions.append(tr);
    }
    renderPagination('individual-executions-pagination',{total:state.individualExecutionTotal,offset:state.individualExecutionOffset,limit:state.individualExecutionLimit,onPrev:()=>{state.individualExecutionOffset=Math.max(0,state.individualExecutionOffset-state.individualExecutionLimit);loadBatches()},onNext:()=>{state.individualExecutionOffset+=state.individualExecutionLimit;loadBatches()}});
    const selected=state.batches.find(batch=>batch.batch_id===state.selectedBatchId);if(selected)inspectBatch(selected);else if(state.batches.length)inspectBatch(state.batches[0]);else{state.selectedBatchId=null;$('batch-inspector-title').textContent='No batch selected';$('batch-inspector-subtitle').textContent='No durable batch record is available.';const inspector=$('batch-inspector-body');clear(inspector);inspector.className='inspector-placeholder';inspector.append(el('span','', 'No batch record is selected. Individual task runs are listed below; they are not grouped batch records.'))}
  }catch(error){if(!quiet)notify(`Unable to load batch history: ${error.message}`,true);}
}
async function loadPolicies(quiet=false) {
  try {
    state.policyQuery=$('policy-search').value.trim();state.policyVersions=$('policy-version-filter').value||'latest';
    const params=new URLSearchParams({q:state.policyQuery,versions:state.policyVersions,limit:'200'});
    const data=await api(`/api/policies?${params}`);state.policies=data;
    const summary=data.summary||{};
    $('nav-policies-count').textContent=fmtNumber(summary.policy_count||0);
    renderRegistrySummary('policy-summary',[
      ['Policy packs',summary.policy_count||0,'Reusable policy identities'],
      ['Immutable versions',summary.policy_versions||0,'Stored content snapshots'],
      ['Workflow attachments',summary.attachments||0,'Exact version pins'],
      ['Audit events',summary.audit_events||0,'Append-only policy history'],
      ['Recorded violations',summary.recorded_violations||0,'Historical failed predicates; not automatically cleared']
    ]);
    $('policy-list-caption').textContent=`${(data.policies||[]).length} ${state.policyVersions==='all'?'stored versions':'latest policy versions'} shown · SHA-256 identifies the immutable definition`;
    const policies=$('policy-list');clear(policies);
    if(!data.policies?.length){const tr=el('tr'),td=el('td','table-empty',state.policyQuery?'No policy packs match this filter.':(data.note||'No workflow policy packs have been created. Use workflow_policy_create and workflow_policy_attach through the MCP tools.'));td.colSpan=6;tr.append(td);policies.append(tr);}
    for(const policy of data.policies||[]){
      const tr=el('tr');
      const name=el('td');append(name,el('strong','',policy.name),el('small','mono',policy.policy_id),el('small','',policy.description||'No description recorded.'));
      const rules=el('td');append(rules,el('span','status-pill status-live',`${policy.constraint_count||0} constraints`),el('span','status-pill status-live',`${policy.success_criteria_count||0} criteria`));
      const types=[...(policy.constraints||[]),...(policy.success_criteria||[])].map(rule=>`${rule.type||'unknown'} (${rule.id||'unidentified'})`);
      if(types.length)rules.title=types.join('\n');
      const hash=el('td','mono',policy.content_hash?`${policy.content_hash.slice(0,12)}…${policy.content_hash.slice(-8)}`:'Invalid/missing hash');hash.title=policy.content_hash||'';
      const validation=el('td');validation.append(pill(policy.validation_status||'unknown'),el('small','',`${policy.violation_count||0} recorded violation${Number(policy.violation_count||0)===1?'':'s'}`));if(policy.validation_reason)validation.title=policy.validation_reason;
      const created=el('td');created.append(policy.created_at?relativeTime(policy.created_at):el('span','','—'));
      if(policy.definition_truncated)created.append(el('small','status-failed','Definition preview truncated or malformed'));
      append(tr,name,el('td','mono',`v${policy.version}`),rules,hash,validation,created);policies.append(tr);
    }
    const attachments=$('policy-attachment-list');clear(attachments);
    if(!data.attachments?.length){const tr=el('tr'),td=el('td','table-empty','No workflow policy attachments match this filter. Packs may exist without being attached to a proposal.');td.colSpan=6;tr.append(td);attachments.append(tr);}
    for(const attachment of data.attachments||[]){
      const tr=el('tr');const workflow=el('td');append(workflow,el('strong','',attachment.job_title||attachment.job_id),el('small','mono',compactId(attachment.job_id,24)));
      const policy=el('td');append(policy,el('strong','',attachment.name||attachment.policy_id),el('small','mono',`${attachment.policy_id}@${attachment.version}`));
      const hash=el('td','mono',attachment.content_hash?`${attachment.content_hash.slice(0,12)}…${attachment.content_hash.slice(-8)}`:'Invalid/missing hash');hash.title=attachment.content_hash||'';
      const validation=el('td');validation.append(pill(attachment.validation_status||'unknown'));if(attachment.validation_reason)validation.title=attachment.validation_reason;
      const when=el('td');when.append(attachment.attached_at?relativeTime(attachment.attached_at):el('span','','—'));
      append(tr,workflow,policy,pill(attachment.job_state||attachment.job_status),hash,validation,when);tr.title=`Attached by ${attachment.attached_by||'unknown actor'}`;attachments.append(tr);
    }
    const events=$('policy-event-list');clear(events);
    if(!data.events?.length){const tr=el('tr'),td=el('td','table-empty','No policy audit events match this filter.');td.colSpan=5;tr.append(td);events.append(tr);}
    for(const event of data.events||[]){const tr=el('tr');const type=el('td');append(type,pill(event.event_type),el('small','mono',compactId(event.event_id,20)));const policy=el('td');append(policy,el('strong','',event.policy_id),el('small','mono',event.version?`v${event.version}`:'—'));const when=el('td');when.append(event.created_at?relativeTime(event.created_at):el('span','','—'));append(tr,type,policy,el('td','mono',event.version?`v${event.version}`:'—'),el('td','',event.created_by||'—'),when);tr.title=JSON.stringify(event.payload||{});events.append(tr);}
    if(data.enforcement_note)$('policies-view').dataset.enforcementNote=data.enforcement_note;
  } catch(error) {if(!quiet)notify(`Unable to load policy registry: ${error.message}`,true);}
}
async function loadFiles(relative='') {
  state.filePath=relative;try{const data=await api(`/api/files?path=${encodeURIComponent(relative)}`);const target=$('file-list');clear(target);$('file-breadcrumb').textContent=data.path?`/${data.path}`:'/';$('file-up').disabled=!data.parent;$('file-up').onclick=()=>loadFiles(data.parent||'');if(!data.entries.length)target.append(el('div','table-empty','No supported text/log files in this folder.'));for(const item of data.entries){const row=el('div',`file-row ${item.kind}`);append(row,el('span','file-glyph',item.kind==='directory'?'▰':'▤'),el('span','file-name',item.name),el('span','file-size',item.kind==='file'?humanSize(item.size):'DIR'),el('span','file-date',ago(item.modified_at)));row.title=item.path;row.addEventListener('click',()=>item.kind==='directory'?loadFiles(item.path):previewFile(item.path));target.append(row);}if(data.truncated)target.append(el('div','file-footnote','Showing the first 200 entries. Narrow folders to browse further.'));
  }catch(error){notify(`Unable to browse local files: ${error.message}`,true)}
}
function humanSize(value){const n=Number(value||0);if(n<1024)return `${n} B`;if(n<1024*1024)return `${(n/1024).toFixed(1)} KB`;return `${(n/1048576).toFixed(1)} MB`;}
async function previewFile(relative){
  try{const f=await api(`/api/files/preview?path=${encodeURIComponent(relative)}`);state.filePreviewPath=relative;$('file-preview-title').textContent=relative.split('/').pop();$('file-preview-meta').textContent=`${humanSize(f.size)} · modified ${dateTime(f.modified_at)}${f.truncated?' · PREVIEW TRUNCATED':''}`;$('file-preview-content').textContent=f.preview+(f.truncated?'\n\n[Preview truncated at 64 KB]':'');const copyPath=$('file-copy-path');if(copyPath)copyPath.disabled=false;notify(`Opened read-only preview: ${relative}`)}catch(error){notify(`File preview denied: ${error.message}`,true)}
}
async function refreshAll(quiet=false){if(refreshInFlight)return false;refreshInFlight=true;try{const ok=await refreshOverview();if(state.view==='workflows')await loadJobs(quiet);if(state.view==='roles')await loadRoles(quiet);if(state.view==='policies')await loadPolicies(quiet);if(state.view==='batches')await loadBatches(quiet);if(state.view==='events')await loadEvents();if(state.view==='artifacts')await loadArtifacts();if(state.view==='files'&&state.filePath)await loadFiles(state.filePath);return ok;}finally{refreshInFlight=false;}}
function debounce(fn,delay=180){let timer;return(...args)=>{clearTimeout(timer);timer=setTimeout(()=>fn(...args),delay)}}
for(const b of document.querySelectorAll('.nav-item')) b.addEventListener('click',()=>setView(b.dataset.view));
for(const b of document.querySelectorAll('[data-open-view]')) b.addEventListener('click',()=>setView(b.dataset.openView));
 $('refresh-button').addEventListener('click',()=>refreshAll().then(ok=>{if(ok)notify('Snapshot refreshed');else notify('Refresh failed; last snapshot retained',true)}).catch(e=>notify(e.message,true)));
 $('hero-refresh').addEventListener('click',()=>refreshAll().then(ok=>{if(ok)notify('Snapshot refreshed');else notify('Refresh failed; last snapshot retained',true)}).catch(e=>notify(e.message,true)));
 $('global-search').value=state.jobQuery;$('workflow-status-filter').value=state.statusFilter;
 $('workflow-status-filter').addEventListener('change',()=>{state.statusFilter=$('workflow-status-filter').value;state.jobOffset=0;saveSessionPrefs();loadJobs()});
 $('workflow-phase-filter').addEventListener('change',()=>{state.phaseFilter=$('workflow-phase-filter').value;state.jobOffset=0;saveSessionPrefs();loadJobs()});
 for(const b of document.querySelectorAll('[data-quick-status]'))b.addEventListener('click',()=>{state.statusFilter=state.statusFilter===b.dataset.quickStatus?'':b.dataset.quickStatus;$('workflow-status-filter').value=state.statusFilter;state.jobOffset=0;saveSessionPrefs();loadJobs()});
 $('clear-workflow-filters').addEventListener('click',()=>{state.jobQuery='';state.statusFilter='';state.phaseFilter='';state.jobOffset=0;$('global-search').value='';$('workflow-status-filter').value='';$('workflow-phase-filter').value='';saveSessionPrefs();loadJobs()});
for(const b of document.querySelectorAll('[data-attention-filter]'))b.addEventListener('click',()=>renderAttentionList(state.attentionFilter===b.dataset.attentionFilter?'all':b.dataset.attentionFilter));
$('event-search').addEventListener('input',debounce(()=>{state.eventOffset=0;loadEvents()}));
$('event-type-filter').addEventListener('change',()=>{state.eventOffset=0;loadEvents()});
$('artifact-search').addEventListener('input',debounce(()=>{state.artifactOffset=0;loadArtifacts()}));
$('artifact-type-filter').addEventListener('change',()=>{state.artifactOffset=0;loadArtifacts()});
 $('role-search').addEventListener('input',debounce(()=>loadRoles(true)));
 $('role-version-filter').addEventListener('change',()=>loadRoles());
 $('policy-search').addEventListener('input',debounce(()=>loadPolicies(true)));
 $('policy-version-filter').addEventListener('change',()=>loadPolicies());
 $('batch-search').addEventListener('input',debounce(()=>{state.batchOffset=0;state.individualExecutionOffset=0;loadBatches(true)}));
 $('batch-status-filter').addEventListener('change',()=>{state.batchOffset=0;state.individualExecutionOffset=0;loadBatches()});
$('file-refresh').addEventListener('click',()=>loadFiles(state.filePath));
 $('global-search').addEventListener('input',debounce(()=>{state.jobQuery=$('global-search').value.trim();saveSessionPrefs();if(state.view==='workflows'){state.jobOffset=0;loadJobs(true)}},180));
 $('global-search').addEventListener('keydown',e=>{if(e.key==='Enter'){state.jobQuery=$('global-search').value.trim();state.jobOffset=0;saveSessionPrefs();setView('workflows');$('global-search').blur();}if(e.key==='Escape'){$('global-search').value='';state.jobQuery='';state.jobOffset=0;saveSessionPrefs();if(state.view==='workflows')loadJobs(true)}});
 const previewHead=document.querySelector('.preview-head');if(previewHead){const limit=previewHead.querySelector('.preview-limit');const actions=el('div','preview-actions');const copyPath=el('button','copy-button','Copy path');copyPath.id='file-copy-path';copyPath.disabled=true;copyPath.addEventListener('click',()=>copyText(state.filePreviewPath,'File path'));append(actions,limit,copyPath);previewHead.append(actions);}
 document.addEventListener('keydown',e=>{if(e.key==='/'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)){e.preventDefault();$('global-search').focus();}});
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshAll(true)});
refreshAll(true);
pollTimer=setInterval(()=>{if(document.visibilityState==='visible'&&state.autoRefresh)refreshAll(true)},20000);
window.addEventListener('beforeunload',()=>clearInterval(pollTimer));
