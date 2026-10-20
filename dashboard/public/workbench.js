(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const nav = [...document.querySelectorAll('.nav-item[data-view]')];
  const groups = [...document.querySelectorAll('[data-sidebar-group]')];
  const contextLabels = {home:'HOME',explorer:'EXPLORER',search:'SEARCH',sourceControl:'SOURCE CONTROL',runalith:'RUNALITH',observability:'OBSERVABILITY',problems:'HEALTH & DIAGNOSTICS'};
  const viewLabels = {overview:'Overview',workflows:'Workflows',roles:'Roles & Skills',policies:'Policies',batches:'Batch execution',events:'Event stream',artifacts:'Artifacts',files:'Explorer'};
  const utilityLabels = {search:'Global Search',problems:'Problems',diagnostics:'Diagnostics'};
  const viewContainer = {overview:'home',files:'explorer',workflows:'runalith',roles:'runalith',policies:'runalith',artifacts:'runalith',batches:'observability',events:'observability'};
  const activities = [
    ['home','⌂','Home','Open Overview'],
    ['explorer','▤','Explorer','Workspace tree and open editors'],
    ['search','⌕','Search','Search workflows, events, artifacts and files'],
    ['sourceControl','⑂','Source Control','Inspect Git changes (read-only)'],
    ['runalith','◈','Runalith','Workflows, roles, policies and artifacts'],
    ['observability','≋','Observability','Batches and event stream'],
    ['problems','!','Problems','Problems and local diagnostics']
  ];
  const state = {
    view:'overview',container:'home',utility:null,scMode:false,suppressNavTab:false,
    activeTab:'view:overview',viewTabs:['view:overview'],openEditors:[],selectedEditorPath:null,
    treeLoaded:false,tree:new Map(),git:null,branch:null,selectedGit:null,diffMode:'working-tree',
    bottomTab:'problems',bottomCollapsed:false,globalQuery:'',searchSequence:0,
    workspaceSearchSequence:0,recentErrors:[],problemCount:undefined,lastHealth:null
  };
  function node(tag, cls, text) {
    const el=document.createElement(tag); if(cls)el.className=cls;
    if(text!==undefined&&text!==null)el.textContent=String(text); return el;
  }
  function add(parent,...children){children.filter(Boolean).forEach(child=>parent.append(child));return parent;}
  function safe(value,fallback){return value===null||value===undefined||value===''?(fallback||'—'):String(value);}
  function note(parent,text,cls){parent.append(node('p',cls||'wb-note',text));}
  function recordError(path,error){
    const route=String(path||'').split('?')[0].slice(0,70);
    const message=String(error&&error.message||error||'Request failed')
      .replace(/\/(?:home|tmp|var|opt|mnt|srv|workspace|Users)\/[^\s,;]+/g,'[local path]')
      .replace(/[A-Za-z]:\\[^\s,;]+/g,'[local path]').slice(0,180);
    state.recentErrors.unshift({route,message,at:new Date().toLocaleTimeString()});
    state.recentErrors=state.recentErrors.slice(0,5); updateStatus();
  }
  async function api(path){
    try{
      const response=await fetch(path,{method:'GET',credentials:'same-origin',headers:{accept:'application/json'}});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.error||'Request failed ('+response.status+')');
      return data;
    }catch(error){recordError(path,error);throw error;}
  }
  function pushTab(key){
    state.viewTabs=state.viewTabs.filter(value=>value!==key);state.viewTabs.push(key);
    if(state.viewTabs.length>10)state.viewTabs.splice(0,state.viewTabs.length-10);
    state.activeTab=key;
  }
  function tabLabel(key){
    if(key.startsWith('view:'))return viewLabels[key.slice(5)]||key.slice(5);
    if(key.startsWith('utility:'))return utilityLabels[key.slice(8)]||key.slice(8);
    if(key==='sourceControl')return 'Source Control';return key;
  }
  function syncTabs(){
    const tabs=$('wb-tabs');if(!tabs)return;tabs.replaceChildren();
    state.viewTabs.forEach(key=>{
      const active=state.activeTab===key;
      const button=node('button','wb-tab'+(active?' active':''),tabLabel(key));
      button.type='button';button.dataset.workbenchTab=key;
      button.setAttribute('aria-current',String(active));button.addEventListener('click',()=>activateTab(key));tabs.append(button);
    });
    state.openEditors.slice().forEach(path=>{
      const active=state.activeTab==='file:'+path;
      const wrap=node('span','wb-file-tab-wrap'+(active?' active':''));
      const button=node('button','wb-tab wb-file-tab'+(active?' active':''),path.split('/').pop());
      button.type='button';button.title=path;button.setAttribute('aria-current',String(active));
      button.addEventListener('click',()=>openEditor(path));
      const close=node('button','wb-tab-close','×');close.type='button';close.title='Close '+path;
      close.setAttribute('aria-label','Close '+path);
      close.addEventListener('click',event=>{
        event.stopPropagation();state.openEditors=state.openEditors.filter(value=>value!==path);
        if(state.selectedEditorPath===path){
          state.selectedEditorPath=state.openEditors[state.openEditors.length-1]||null;
          if(state.selectedEditorPath){state.activeTab='file:'+state.selectedEditorPath;if(typeof window.previewFile==='function')window.previewFile(state.selectedEditorPath);}
          else state.activeTab='view:files';
        }
        renderOpenEditors();syncTabs();updateStatus();
      });
      wrap.append(button,close);tabs.append(wrap);
    });
  }
  function activateTab(key){
    if(key.startsWith('view:'))activateView(key.slice(5));
    else if(key.startsWith('utility:'))openUtility(key.slice(8));
    else if(key==='sourceControl')activateSourceControl();
    else if(key.startsWith('file:'))openEditor(key.slice(5));
  }
  function renderShell(){
    groups.forEach(group=>{group.hidden=group.dataset.sidebarGroup!==state.container;});
    const sideTitle=$('wb-sidebar-title');if(sideTitle)sideTitle.textContent=contextLabels[state.container]||'WORKSPACE';
    document.querySelectorAll('.wb-activity button[data-container]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.container===state.container)));
    const utilityView=$('wb-utility-view');
    document.querySelectorAll('.main-column .content-wrap > .view-panel').forEach(panel=>{
      if(panel.id==='wb-utility-view')return;
      panel.classList.toggle('hidden',Boolean(state.utility)||panel.id!==state.view+'-view');
    });
    if(utilityView)utilityView.classList.toggle('hidden',!state.utility);
    const heroTitle=$('page-title'),heroSubtitle=$('page-subtitle');
    const heroRow=document.querySelector('.hero-row');
    if(heroRow)heroRow.classList.toggle('hidden',Boolean(state.utility));
    if(!state.utility&&state.view==='files'){
      document.querySelector('#files-view .section-toolbar')?.classList.add('hidden');
      if(heroTitle)heroTitle.textContent=state.scMode?'Source Control':'Explorer';
      if(heroSubtitle)heroSubtitle.textContent=state.scMode?'Read-only Git review. Select a changed path in the sidebar.':'Read-only file preview from the configured workspace.';
    }
    if(state.utility){
      if(heroTitle)heroTitle.textContent=utilityLabels[state.utility]||'Workbench';
      if(heroSubtitle)heroSubtitle.textContent=({
        search:'Search existing local records and the configured workspace.',
        problems:'Confirmed failures and quiet-job heuristics, kept separate.',
        diagnostics:'Read-only health and local runtime diagnostics.'
      })[state.utility]||'';
    }
    const crumb=$('crumb-current');
    if(crumb)crumb.textContent=state.utility?utilityLabels[state.utility]:(state.scMode?'Source Control':viewLabels[state.view]);
    const trail=$('wb-breadcrumbs');
    if(trail)trail.textContent='RUNALITH / '+(state.utility?utilityLabels[state.utility]:(state.scMode?'Source Control':viewLabels[state.view]))+
      (state.activeTab.startsWith('file:')&&state.selectedEditorPath&&!state.scMode?' / '+state.selectedEditorPath:'');
    document.querySelector('#files-view .section-toolbar')?.classList.toggle('hidden',state.scMode);
    const preview=document.querySelector('#files-view .file-preview-panel'),diff=$('wb-source-control');
    if(preview)preview.classList.toggle('hidden',state.scMode);
    if(diff)diff.classList.toggle('hidden',!state.scMode);
    syncTabs();updateStatus();
  }
  function activateView(view){const button=nav.find(item=>item.dataset.view===view);if(button)button.click();}
  function onNavClick(button){
    state.view=button.dataset.view;state.container=button.dataset.container||viewContainer[state.view]||'home';
    state.utility=null;state.scMode=false;
    if(!state.suppressNavTab)pushTab('view:'+state.view);
    if(state.view==='files'){loadTreeRoot();refreshGitStatus();}
    renderShell();renderOpenEditors();renderBottom();
  }
  nav.forEach(button=>button.addEventListener('click',()=>onNavClick(button)));
  function activateContainer(container){
    if(container==='home')activateView('overview');
    else if(container==='explorer')activateView('files');
    else if(container==='search')openUtility('search');
    else if(container==='sourceControl')activateSourceControl();
    else if(container==='runalith')activateView('workflows');
    else if(container==='observability')activateView('events');
    else if(container==='problems')openUtility('problems');
  }
  function openUtility(which,initialQuery){
    const base=which==='search'?'workflows':'overview';
    state.suppressNavTab=true;const button=nav.find(item=>item.dataset.view===base);if(button)button.click();state.suppressNavTab=false;
    state.utility=which;state.container=which==='search'?'search':'problems';state.scMode=false;
    if(initialQuery!==undefined)state.globalQuery=String(initialQuery);
    pushTab('utility:'+which);renderShell();renderUtility(which);renderBottom();
  }
  function activateSourceControl(){
    if(state.view!=='files'||state.utility){
      state.suppressNavTab=true;const button=nav.find(item=>item.dataset.view==='files');if(button)button.click();state.suppressNavTab=false;
    }
    state.view='files';state.utility=null;state.container='sourceControl';state.scMode=true;
    pushTab('sourceControl');renderShell();refreshGitStatus();
  }
  function updateStatus(){
    const mode=$('wb-status-mode'),context=$('wb-status-context'),git=$('wb-status-git');
    if(mode)mode.textContent='● LOCAL · READ-ONLY';
    if(context)context.textContent=state.activeTab.startsWith('file:')&&state.selectedEditorPath?state.selectedEditorPath:
      (state.utility?utilityLabels[state.utility]:(state.scMode?'Source Control':(viewLabels[state.view]||'Workspace')));
    if(git)git.textContent=state.git?(state.git.git_available?'Git '+(state.git.entries||[]).length+' changed':'Git unavailable'):'Git checking…';
    const count=$('wb-problem-count');if(count&&state.problemCount!==undefined)count.textContent=String(state.problemCount);
  }
  function setupActivityBar(){
    const rail=node('nav','wb-activity');
    rail.setAttribute('aria-label','Workbench view containers');
    activities.forEach(([container,glyph,label,description])=>{
      const button=node('button','',glyph);
      button.type='button';button.dataset.container=container;button.title=description;
      button.setAttribute('aria-label',label+': '+description);
      button.setAttribute('aria-pressed',String(container==='home'));
      button.addEventListener('click',()=>activateContainer(container));
      rail.append(button);
    });
    const spacer=node('div','wb-activity-spacer');
    const settings=node('button','','⌁');
    settings.type='button';settings.title='Local diagnostics';
    settings.setAttribute('aria-label','Open local diagnostics');
    settings.addEventListener('click',()=>openUtility('diagnostics'));
    rail.append(spacer,settings);
    const shell=document.querySelector('.app-shell');
    if(shell)shell.insertBefore(rail,shell.firstChild);
  }
  function setupChrome(){
    const main=document.querySelector('.main-column');if(!main)return;
    const top=main.querySelector('.topbar'),tabs=node('div','wb-tabs'),crumb=node('div','wb-breadcrumbs','RUNALITH / Overview');
    tabs.id='wb-tabs';tabs.setAttribute('role','navigation');tabs.setAttribute('aria-label','Open views and files');
    crumb.id='wb-breadcrumbs';if(top){top.after(tabs);tabs.after(crumb);}
    const bottom=node('section','wb-bottom');bottom.id='wb-bottom';
    const head=node('div','wb-bottom-head');head.setAttribute('role','tablist');head.setAttribute('aria-label','Bottom panel');
    [['problems','Problems'],['events','Events'],['diagnostics','Diagnostics']].forEach(([id,label])=>{
      const button=node('button','wb-bottom-tab',label);button.type='button';button.dataset.bottomTab=id;button.id='wb-bottom-tab-'+id;
      button.setAttribute('role','tab');button.setAttribute('aria-controls','wb-bottom-body');
      button.setAttribute('aria-selected',String(id===state.bottomTab));
      button.addEventListener('click',()=>{state.bottomTab=id;state.bottomCollapsed=false;renderBottom();});head.append(button);
    });
    const toggle=node('button','wb-bottom-toggle','Hide panel');toggle.type='button';
    toggle.setAttribute('aria-expanded','true');toggle.setAttribute('aria-controls','wb-bottom-body');
    toggle.addEventListener('click',()=>{state.bottomCollapsed=!state.bottomCollapsed;bottom.classList.toggle('collapsed',state.bottomCollapsed);toggle.textContent=state.bottomCollapsed?'Show panel':'Hide panel';toggle.setAttribute('aria-expanded',String(!state.bottomCollapsed));renderBottom();});
    head.append(toggle);
    const body=node('div','wb-bottom-body');body.id='wb-bottom-body';body.setAttribute('role','tabpanel');body.setAttribute('tabindex','0');body.setAttribute('aria-labelledby','wb-bottom-tab-problems');
    bottom.append(head,body);main.append(bottom);
    const status=node('div','status-bar');status.id='wb-status';
    const mode=node('span','','● LOCAL · READ-ONLY');mode.id='wb-status-mode';
    const context=node('span','','Overview');context.id='wb-status-context';
    const git=node('span','','Git checking…');git.id='wb-status-git';status.append(mode,context,git);
    document.querySelector('.app-shell').append(status);renderBottom();
  }
  function setupActions(){
    document.addEventListener('click',event=>{
      const button=event.target.closest('[data-workbench-action]');if(!button)return;
      const action=button.dataset.workbenchAction;
      if(action==='search')openUtility('search');
      else if(action==='quick-open')openQuickOpen();
      else if(action==='sourceControl')activateSourceControl();
      else if(action==='problems')openUtility('problems');
      else if(action==='diagnostics')openUtility('diagnostics');
      else if(action==='refresh-git')refreshGitStatus();
    });
    const search=$('global-search');
    if(search)search.addEventListener('keydown',event=>{
      if(event.key==='Enter'){event.preventDefault();openUtility('search',search.value.trim());}
      else if(event.key==='Escape')search.value='';
    });
    document.addEventListener('keydown',event=>{
      const typing=['INPUT','TEXTAREA','SELECT'].includes(document.activeElement&&document.activeElement.tagName);
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='p'&&!event.shiftKey){event.preventDefault();openQuickOpen();}
      else if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.key.toLowerCase()==='p'){event.preventDefault();openCommandPalette();}
      else if(event.key==='/'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!typing){event.preventDefault();search?.focus();}
    });
    document.querySelectorAll('[data-open-view]').forEach(button=>button.addEventListener('click',()=>activateView(button.dataset.openView)));
    document.querySelectorAll('[data-attention-filter]').forEach(button=>button.addEventListener('click',()=>openUtility('problems')));
  }
  function setupExplorer(){
    const host=$('wb-explorer-sidebar');if(!host)return;
    const wrap=node('section','wb-tree-wrap'),head=node('div','wb-tree-head');
    const root=node('span','','Configured workspace');root.id='wb-root-label';
    const refresh=node('button','wb-small-action','↻');refresh.type='button';refresh.title='Refresh workspace tree';refresh.setAttribute('aria-label','Refresh workspace tree');
    refresh.addEventListener('click',()=>{state.treeLoaded=false;$('wb-tree')?.replaceChildren();loadTreeRoot();});
    head.append(root,refresh);
    const editorsTitle=node('div','wb-tree-subhead','OPEN EDITORS');
    const editors=node('div','wb-open-editors');editors.id='wb-open-editors';
    const search=node('input','wb-tree-search');search.type='search';search.placeholder='Search workspace…';search.setAttribute('aria-label','Search configured workspace files and folders');
    const tree=node('div','wb-tree');tree.id='wb-tree';tree.setAttribute('role','tree');tree.setAttribute('aria-label','Configured workspace');
    wrap.append(head,editorsTitle,editors,search,tree);host.append(wrap);
    search.addEventListener('input',debounce(()=>{const query=search.value.trim().toLowerCase();if(query)searchWorkspace(query,tree);else{state.workspaceSearchSequence++;state.treeLoaded=false;loadTreeRoot();}},160));
    renderOpenEditors();loadTreeRoot();
  }
  async function loadTreeRoot(){const tree=$('wb-tree');if(!tree||state.treeLoaded)return;state.treeLoaded=true;await loadTreePath('',tree,0);if(!state.git)refreshGitStatus();}
  async function loadTreePath(path,host,depth){
    if(!host)return;host.replaceChildren();let data;
    try{data=await api('/api/files?path='+encodeURIComponent(path));}
    catch(error){host.append(node('div','table-empty','Workspace unavailable: '+error.message));return;}
    state.tree.set(path,data.entries||[]);
    if(!path&&$('wb-root-label'))$('wb-root-label').textContent=safe(data.root_label,'Configured workspace');
    for(const item of data.entries||[]){
      const row=node('button','wb-tree-row');row.type='button';row.style.paddingLeft=(7+depth*13)+'px';row.dataset.treePath=item.path;row.setAttribute('role','treeitem');row.setAttribute('aria-level',String(depth+1));
      const arrow=node('span','wb-tree-chevron',item.kind==='directory'?'›':''),glyph=node('span','wb-tree-glyph',item.kind==='directory'?'▰':'▤'),name=node('span','wb-tree-name',item.name);
      row.append(arrow,glyph,name);
      if(item.kind==='directory'){
        row.setAttribute('aria-expanded','false');
        row.addEventListener('click',async()=>{
          const next=row.nextElementSibling;
          if(next&&next.classList.contains('wb-tree-children')){next.hidden=!next.hidden;row.setAttribute('aria-expanded',String(!next.hidden));arrow.textContent=next.hidden?'›':'⌄';return;}
          const children=node('div','wb-tree-children');children.setAttribute('role','group');row.after(children);row.setAttribute('aria-expanded','true');arrow.textContent='⌄';await loadTreePath(item.path,children,depth+1);
        });
      }else row.addEventListener('click',()=>openEditor(item.path));
      host.append(row);
    }
    renderTreeBadges();
  }
  function statusBadge(kind){
    const map={modified:['M','git-modified'],added:['A','git-added'],untracked:['U','git-untracked'],deleted:['D','git-deleted'],renamed:['R','git-renamed'],copied:['C','git-copied'],conflict:['!','git-conflict'],type_changed:['T','git-modified']};
    return map[kind]||['',''];
  }
  function changedUnder(path){return(state.git&&state.git.entries||[]).filter(entry=>entry.path===path||entry.path.startsWith(path+'/'));}
  function renderTreeBadges(){
    document.querySelectorAll('[data-tree-path]').forEach(row=>{
      const entries=changedUnder(row.dataset.treePath);let badge=row.querySelector('.wb-git-badge');
      if(!badge){badge=node('span','wb-git-badge');row.append(badge);}
      if(entries.length){
        const priority=['conflict','deleted','modified','added','untracked','renamed','copied'];
        const kind=priority.find(value=>entries.some(entry=>entry.kind===value))||entries[0].kind;const pair=statusBadge(kind);
        badge.textContent=row.dataset.treePath.includes('/')?pair[0]:String(entries.length);badge.className='wb-git-badge '+pair[1];badge.title=entries.length+' changed path(s)';
      }else{badge.textContent='';badge.removeAttribute('title');}
    });
  }
  function renderOpenEditors(){
    const list=$('wb-open-editors');if(!list)return;list.replaceChildren();
    if(!state.openEditors.length){list.append(node('div','wb-open-empty','No open files'));return;}
    state.openEditors.slice().reverse().forEach(path=>{
      const row=node('div','wb-open-row'),button=node('button','wb-open-file'+(path===state.selectedEditorPath?' active':''),path.split('/').pop());
      button.type='button';button.title=path;button.setAttribute('aria-current',String(path===state.selectedEditorPath));button.addEventListener('click',()=>openEditor(path));
      const close=node('button','wb-open-close','×');close.type='button';close.title='Close '+path;close.setAttribute('aria-label','Close '+path);
      close.addEventListener('click',()=>{
        state.openEditors=state.openEditors.filter(value=>value!==path);
        if(state.selectedEditorPath===path){
          state.selectedEditorPath=state.openEditors[state.openEditors.length-1]||null;
          if(state.selectedEditorPath){state.activeTab='file:'+state.selectedEditorPath;if(typeof window.previewFile==='function')window.previewFile(state.selectedEditorPath);}
          else state.activeTab='view:files';
        }
        renderOpenEditors();syncTabs();updateStatus();
      });
      row.append(button,close);list.append(row);
    });
  }
  function openEditor(path){
    if(!path)return;
    if(!state.openEditors.includes(path))state.openEditors.push(path);
    if(state.openEditors.length>12)state.openEditors.shift();
    state.selectedEditorPath=path;
    const button=nav.find(item=>item.dataset.view==='files');
    if(state.view!=='files'||state.utility||state.scMode)button?.click();
    state.container='explorer';state.view='files';state.utility=null;state.scMode=false;state.activeTab='file:'+path;
    renderShell();renderOpenEditors();syncTabs();renderBottom();updateStatus();
    document.querySelectorAll('[data-tree-path][aria-current="true"]').forEach(row=>row.removeAttribute('aria-current'));
    const row=[...document.querySelectorAll('[data-tree-path]')].find(item=>item.dataset.treePath===path);if(row)row.setAttribute('aria-current','true');
    if(typeof window.previewFile==='function')window.previewFile(path);
  }
  async function searchWorkspace(query,host){
    const seq=++state.workspaceSearchSequence;host.replaceChildren(node('div','table-empty','Searching configured workspace…'));
    const queue=[{path:'',depth:0}],results=[];let visited=0,seen=0,capped=false;
    while(queue.length&&visited<40&&seen<1000&&results.length<100&&seq===state.workspaceSearchSequence){
      const current=queue.shift();let data;
      try{data=await api('/api/files?path='+encodeURIComponent(current.path));}
      catch(error){if(seq===state.workspaceSearchSequence)host.replaceChildren(node('div','table-empty','Workspace search unavailable: '+error.message));return;}
      visited++;
      for(const item of data.entries||[]){
        seen++;if(String(item.name||'').toLowerCase().includes(query))results.push(item);
        if(item.kind==='directory'&&current.depth<8)queue.push({path:item.path,depth:current.depth+1});
        if(seen>=1000||results.length>=100){capped=true;break;}
      }
    }
    if(seq!==state.workspaceSearchSequence)return;if(queue.length||visited>=40||seen>=1000||results.length>=100)capped=true;
    host.replaceChildren();if(!results.length)host.append(node('div','table-empty','No matching supported files or folders.'));
    results.slice(0,100).forEach(item=>{
      const button=node('button','wb-tree-row');button.type='button';button.append(node('span','wb-tree-glyph',item.kind==='directory'?'▰':'▤'),node('span','wb-tree-name',item.path||item.name));
      button.addEventListener('click',()=>{if(item.kind==='file')openEditor(item.path);else{const input=document.querySelector('.wb-tree-search');if(input)input.value='';state.treeLoaded=false;loadTreePath(item.path,$('wb-tree'),0);if($('wb-root-label'))$('wb-root-label').textContent=safe(item.path,'Configured workspace');}});
      host.append(button);
    });
    if(capped)note(host,'Search bounded to 40 folders, 1,000 entries and 100 matches. Refine the query to continue.','wb-search-limit');
  }
  async function collectWorkspaceMatches(query,limit){
    const seq=++state.workspaceSearchSequence,queue=[{path:'',depth:0}],results=[];let visited=0,seen=0,capped=false;
    while(queue.length&&visited<40&&seen<1000&&results.length<limit&&seq===state.workspaceSearchSequence){
      const current=queue.shift(),data=await api('/api/files?path='+encodeURIComponent(current.path));visited++;
      for(const item of data.entries||[]){
        seen++;if(String(item.name||'').toLowerCase().includes(query.toLowerCase()))results.push(item);
        if(item.kind==='directory'&&current.depth<8)queue.push({path:item.path,depth:current.depth+1});
        if(seen>=1000||results.length>=limit){capped=true;break;}
      }
    }
    if(queue.length||visited>=40||seen>=1000||results.length>=limit)capped=true;
    return{items:results.slice(0,limit),capped,visited,seen,cancelled:seq!==state.workspaceSearchSequence};
  }
  async function refreshGitStatus(){
    try{state.git=await api('/api/git/status');state.branch=state.git.branch||null;}
    catch(error){state.git={git_available:false,entries:[],reason:error.message};}
    renderSourceFiles();renderTreeBadges();updateStatus();
    if(state.utility==='diagnostics')renderUtility('diagnostics');
  }
  function renderSourceFiles(){
    const list=$('wb-source-sidebar');if(!list)return;list.replaceChildren();
    if(!state.git){list.append(node('div','table-empty','Checking Git status…'));return;}
    if(!state.git.git_available){list.append(node('div','table-empty','Git unavailable for the configured workspace.'));if(state.git.reason)note(list,String(state.git.reason).slice(0,140),'wb-sidebar-note');return;}
    const entries=(state.git.entries||[]).slice(0,200);
    if(!entries.length){list.append(node('div','table-empty','Working tree clean.'));return;}
    entries.forEach(entry=>{
      const pair=statusBadge(entry.kind),button=node('button','wb-source-file'+(state.selectedGit&&state.selectedGit.path===entry.path?' active':''));
      button.type='button';button.dataset.path=entry.path;button.append(node('span','wb-git-badge '+pair[1],pair[0]),node('span','wb-source-name',entry.path),node('small','',(entry.index_status||'?')+'/'+(entry.worktree_status||'?')));
      button.addEventListener('click',()=>showDiff(entry,button,state.diffMode));list.append(button);
    });
    if((state.git.entries||[]).length>entries.length)note(list,'Showing first 200 changed paths.','wb-search-limit');
  }
  async function showDiff(entry,button,mode){
    if(!state.scMode)activateSourceControl();
    state.selectedGit=entry;state.diffMode=mode||state.diffMode||'working-tree';const selector=$('wb-diff-mode');if(selector)selector.value=state.diffMode;
    document.querySelectorAll('.wb-source-file[aria-current="true"]').forEach(row=>row.removeAttribute('aria-current'));if(button)button.setAttribute('aria-current','true');
    syncTabs();updateStatus();const target=$('wb-diff');if(!target)return;target.textContent='Loading bounded diff…';
    try{
      const result=await api('/api/git/diff?path='+encodeURIComponent(entry.path)+'&mode='+encodeURIComponent(state.diffMode)),patch=String(result.patch||'');
      target.replaceChildren();
      if(!patch){target.textContent=entry.kind==='conflict'?'Git reports a conflict. No textual patch is available for this diff mode.':'No textual changes available ('+safe(result.status,entry.kind)+').';return;}
      const lines=patch.split('\n');lines.slice(0,3000).forEach(line=>{
        const cls=line.startsWith('+')&&!line.startsWith('+++')?'add':line.startsWith('-')&&!line.startsWith('---')?'del':line.startsWith('@@')?'hunk':'';
        target.append(node('span',cls,line),document.createTextNode('\n'));
      });
      if(lines.length>3000)note(target,'Diff truncated to 3,000 lines.','wb-search-limit');
    }catch(error){target.textContent='Diff unavailable: '+error.message+'. File may be deleted, binary, oversized, conflicted, or outside the supported text allowlist.';}
  }
  function setupSourceControl(){
    const mode=$('wb-diff-mode');if(mode)mode.addEventListener('change',()=>{state.diffMode=mode.value;if(state.selectedGit)showDiff(state.selectedGit,null,state.diffMode);});
  }
  function debounce(fn,wait){let timeout=null;return(...args)=>{clearTimeout(timeout);timeout=setTimeout(()=>fn(...args),wait||180);};}
  function utilityHeader(root,title,subtitle){
    const header=node('div','wb-utility-heading');header.append(node('div','wb-utility-eyebrow','LOCAL WORKBENCH'),node('h2','',title),node('p','',subtitle));root.append(header);
  }
  function renderUtility(which){
    const root=$('wb-utility-content');if(!root)return;root.replaceChildren();
    if(which==='search')renderGlobalSearch(root);else if(which==='problems')renderProblems(root);else if(which==='diagnostics')renderDiagnostics(root);
  }
  function renderGlobalSearch(root){
    utilityHeader(root,'Global Search','Search workflows, events, artifacts and supported files under the configured workspace root.');
    const toolbar=node('div','wb-search-toolbar'),input=node('input','wb-global-query');input.id='wb-global-query';input.type='search';input.value=state.globalQuery;input.placeholder='Search local records and workspace files…';
    input.setAttribute('aria-label','Search workflows, events, artifacts and workspace files');toolbar.append(input,node('span','wb-search-shortcut','Enter to search · results are bounded'));root.append(toolbar);
    const results=node('div','wb-search-results');results.id='wb-search-results';results.setAttribute('aria-live','polite');root.append(results);
    input.addEventListener('input',debounce(()=>{state.globalQuery=input.value.trim();runGlobalSearch(state.globalQuery,results);},220));
    input.addEventListener('keydown',event=>{if(event.key==='Escape'){input.value='';state.globalQuery='';results.replaceChildren(node('div','wb-empty-state','Type at least two characters to search.'));}});
    runGlobalSearch(state.globalQuery,results);if(!state.globalQuery)input.focus({preventScroll:true});
  }
  async function runGlobalSearch(query,host){
    const seq=++state.searchSequence;state.workspaceSearchSequence++;host.replaceChildren();
    if(query.length<2){host.append(node('div','wb-empty-state','Type at least two characters. Search is limited to existing records and the configured workspace tree.'));return;}
    host.append(node('div','wb-loading','Searching local sources…'));
    const requests=await Promise.allSettled([
      api('/api/jobs?q='+encodeURIComponent(query)+'&limit=12&offset=0'),
      api('/api/events?q='+encodeURIComponent(query)+'&limit=12&offset=0'),
      api('/api/artifacts?q='+encodeURIComponent(query)+'&limit=12&offset=0'),
      collectWorkspaceMatches(query,25)
    ]);
    if(seq!==state.searchSequence||state.utility!=='search')return;host.replaceChildren();let total=0,failures=0;
    const sections=[
      {name:'Workflows',result:requests[0],map:item=>({title:safe(item.title,item.job_id),meta:safe(item.status,item.state)+' · '+safe(item.phase,'phase unknown')+' · '+safe(item.job_id),action:()=>openJobResult(item.job_id)})},
      {name:'Events',result:requests[1],map:item=>({title:safe(item.type,'Event'),meta:safe(item.job_id,item.event_id||item.workflow_event_id)+' · '+safe(item.created_at),action:()=>openEventResult(item)})},
      {name:'Artifacts',result:requests[2],map:item=>({title:safe(item.type,'Artifact'),meta:safe(item.producer_role,'unknown producer')+' · '+safe(item.artifact_id),action:()=>openArtifactResult(item.artifact_id)})},
      {name:'Workspace files',result:requests[3],map:item=>({title:safe(item.name,item.path),meta:safe(item.path,item.name)+(item.kind==='directory'?' · folder':' · file'),action:()=>item.kind==='file'?openEditor(item.path):openWorkspaceFolder(item.path)})}
    ];
    sections.forEach(section=>{
      const group=node('section','wb-search-source'),heading=node('div','wb-search-source-head'),result=section.result;group.append(heading);
      if(result.status==='rejected'){
        failures++;heading.append(node('h3','',section.name),node('span','wb-source-unavailable','Unavailable'));
        group.append(node('p','wb-source-error',String(result.reason&&result.reason.message||'Source unavailable').slice(0,150)));host.append(group);return;
      }
      const items=section.name==='Workspace files'?(result.value.items||[]):(result.value.items||[]);
      heading.append(node('h3','',section.name),node('span','wb-result-count',items.length+' found'));total+=items.length;
      if(!items.length)group.append(node('p','wb-empty-hint','No matching records in this source.'));
      items.slice(0,12).forEach(item=>{
        const mapped=section.map(item),button=node('button','wb-result-row');button.type='button';
        button.append(node('span','wb-result-source',section.name),node('strong','',mapped.title),node('small','',mapped.meta));button.addEventListener('click',mapped.action);group.append(button);
      });
      if(section.name==='Workspace files'&&result.value.capped)note(group,'Workspace scan reached a safety/result cap; refine the query for more.','wb-search-limit');
      host.append(group);
    });
    host.append(node('div','wb-search-foot','At most 12 records per source and 25 workspace paths. '+total+' matches shown'+(failures?'; '+failures+' source(s) unavailable.':'.')));
  }
  function openJobResult(jobId){if(!jobId)return;activateView('workflows');if(typeof window.openJob==='function')window.openJob(jobId);else{const input=$('global-search');if(input){input.value=jobId;input.dispatchEvent(new Event('input',{bubbles:true}));}}}
  function openEventResult(evt){activateView('events');if(typeof window.inspectEvent==='function')window.inspectEvent(evt);else{const input=$('event-search');if(input){input.value=evt.event_id||evt.workflow_event_id||evt.type||'';input.dispatchEvent(new Event('input',{bubbles:true}));}}}
  function openArtifactResult(id){activateView('artifacts');if(id&&typeof window.inspectArtifact==='function')window.inspectArtifact(id);}
  function openWorkspaceFolder(path){activateView('files');const input=document.querySelector('.wb-tree-search');if(input)input.value='';state.treeLoaded=false;loadTreePath(path,$('wb-tree'),0);if($('wb-root-label'))$('wb-root-label').textContent=safe(path,'Configured workspace');}
  async function fetchProblemJobs(){const data=await api('/api/jobs?limit=100&offset=0');return data.items||[];}
  function classifyProblems(jobs){
    const failed=[],quiet=[],now=Date.now();
    jobs.forEach(job=>{
      const status=String(job.status||job.state||'').toLowerCase();
      if(['failed','failure','error'].includes(status))failed.push(job);
      else{const updated=Date.parse(job.updated_at||''),active=['active','running','pending','waiting'].includes(status);if(active&&Number.isFinite(updated)&&now-updated>15*60*1000)quiet.push(job);}
    });
    return{failed:failed.slice(0,20),quiet:quiet.slice(0,20),totalFailed:failed.length,totalQuiet:quiet.length};
  }
  async function renderProblems(root){
    utilityHeader(root,'Problems','Confirmed failures are separate from quiet-job heuristics. This view never retries or changes a workflow.');
    const content=node('div','wb-problems-content');content.append(node('div','wb-loading','Loading recent workflow state…'));root.append(content);
    try{
      const issues=classifyProblems(await fetchProblemJobs());if(state.utility!=='problems')return;
      state.problemCount=issues.totalFailed+issues.totalQuiet;updateStatus();content.replaceChildren();
      const summary=node('div','wb-problem-summary');summary.append(problemStat('Confirmed failures',issues.totalFailed,'failed'),problemStat('Quiet >15m heuristic',issues.totalQuiet,'quiet'));content.append(summary);
      content.append(problemGroup('Confirmed failures','Failures reported by stored workflow status.',issues.failed,'failed'));
      content.append(problemGroup('Quiet >15m heuristic','Time-based hint only. Quiet does not prove failure.',issues.quiet,'quiet'));
    }catch(error){content.replaceChildren(node('div','wb-error-state','Unable to load Problems: '+error.message));}
  }
  function problemStat(title,count,type){const box=node('article','wb-problem-stat '+type);box.append(node('span','',title),node('strong','',String(count)));return box;}
  function problemGroup(title,description,jobs,type){
    const group=node('section','wb-problem-group');group.append(node('div','wb-utility-section-head',title),node('p','wb-note',description));
    if(!jobs.length)group.append(node('div','wb-empty-state','No items in this category.'));
    jobs.forEach(job=>{
      const button=node('button','wb-problem-row');button.type='button';button.append(node('span','wb-problem-marker '+type,type==='failed'?'!':'◷'));
      const text=node('span','wb-problem-copy');text.append(node('strong','',safe(job.title,job.job_id)),node('small','',safe(job.status,job.state)+' · updated '+safe(job.updated_at)));
      button.append(text,node('span','wb-problem-open','Inspect →'));button.addEventListener('click',()=>openJobResult(job.job_id));group.append(button);
    });return group;
  }
  async function renderDiagnostics(root){
    utilityHeader(root,'Diagnostics','Current local health only. Paths and file contents are not exposed here.');
    const cards=node('div','wb-diagnostic-grid'),errors=node('section','wb-diagnostic-errors');root.append(cards,errors);cards.append(node('div','wb-loading','Checking local runtime…'));
    const results=await Promise.allSettled([api('/api/health'),api('/api/git/status')]);if(state.utility!=='diagnostics')return;cards.replaceChildren();
    if(results[0].status==='fulfilled'){
      const health=results[0].value;state.lastHealth=health;
      cards.append(diagnosticCard('Dashboard',health.status==='ok'?'Healthy':safe(health.status),'Local mode'));
      cards.append(diagnosticCard('Database',safe(health.database,'Unavailable'),'Read-only SQLite'));
      cards.append(diagnosticCard('Network boundary',safe(health.host,'loopback')+':'+safe(health.port),health.read_only?'Read-only enabled':'Read-only state unknown'));
      cards.append(diagnosticCard('Workspace',safe(health.files_root,'Configured root'),'Configured root label'));
    }else cards.append(diagnosticCard('Dashboard','Unavailable',String(results[0].reason&&results[0].reason.message||'Health request failed').slice(0,130)));
    if(results[1].status==='fulfilled'){
      state.git=results[1].value;const git=results[1].value;cards.append(diagnosticCard('Git',git.git_available?'Available':'Unavailable',git.git_available?(git.entries||[]).length+' changed paths':safe(git.reason,'Not a Git repository')));
    }else cards.append(diagnosticCard('Git','Unavailable',String(results[1].reason&&results[1].reason.message||'Git status failed').slice(0,130)));
    renderSourceFiles();renderTreeBadges();updateStatus();errors.append(node('h3','','Recent request issues'));
    if(!state.recentErrors.length)errors.append(node('div','wb-empty-state','No request errors recorded in this session.'));
    else state.recentErrors.forEach(item=>{const row=node('div','wb-diagnostic-error-row');row.append(node('code','',item.route),node('span','',item.message),node('small','',item.at));errors.append(row);});
  }
  function diagnosticCard(title,value,detail){const card=node('article','wb-diagnostic-card');card.append(node('span','wb-diagnostic-label',title),node('strong','',value),node('small','',detail));return card;}
  function renderBottom(){
    const body=$('wb-bottom-body');if(!body)return;body.replaceChildren();
    document.querySelectorAll('[data-bottom-tab]').forEach(tab=>{const selected=tab.dataset.bottomTab===state.bottomTab;tab.setAttribute('aria-selected',String(selected));if(selected)body.setAttribute('aria-labelledby',tab.id);});
    if(state.bottomCollapsed){$('wb-bottom')?.classList.add('collapsed');body.hidden=true;return;}
    $('wb-bottom')?.classList.remove('collapsed');body.hidden=false;
    if(state.bottomTab==='problems')renderBottomProblems(body);else if(state.bottomTab==='events')renderBottomEvents(body);else renderBottomDiagnostics(body);
  }
  async function renderBottomProblems(body){
    body.append(node('div','wb-loading','Loading Problems…'));
    try{
      const result=classifyProblems(await fetchProblemJobs());if(state.bottomTab!=='problems'||state.bottomCollapsed)return;
      state.problemCount=result.totalFailed+result.totalQuiet;updateStatus();body.replaceChildren();body.append(node('span','wb-bottom-summary',result.totalFailed+' confirmed failure(s)'));
      result.failed.slice(0,4).forEach(job=>{const button=node('button','wb-bottom-row');button.type='button';button.append(node('strong','',safe(job.title,job.job_id)),node('span','wb-problem-marker failed','!'));button.addEventListener('click',()=>openJobResult(job.job_id));body.append(button);});
      if(result.totalQuiet)note(body,result.totalQuiet+' active-like record(s) quiet >15m; heuristic only.','wb-note');
      if(!result.totalFailed&&!result.totalQuiet)body.append(node('span','wb-empty-hint','No current problems in the bounded recent job list.'));
    }catch(error){body.replaceChildren(node('span','wb-error-inline','Problems unavailable: '+error.message));}
  }
  async function renderBottomEvents(body){
    body.append(node('div','wb-loading','Loading recent events…'));
    try{
      const data=await api('/api/events?limit=6&offset=0');if(state.bottomTab!=='events'||state.bottomCollapsed)return;body.replaceChildren();
      if(!(data.items||[]).length)body.append(node('span','wb-empty-hint','No recent events.'));
      (data.items||[]).slice(0,6).forEach(item=>{const button=node('button','wb-bottom-row');button.type='button';button.append(node('strong','',safe(item.type,'Event')),node('span','',safe(item.job_id,item.event_id||item.workflow_event_id)));button.addEventListener('click',()=>openEventResult(item));body.append(button);});
    }catch(error){body.replaceChildren(node('span','wb-error-inline','Events unavailable: '+error.message));}
  }
  async function renderBottomDiagnostics(body){
    body.append(node('div','wb-loading','Checking local health…'));
    const results=await Promise.allSettled([api('/api/health'),api('/api/git/status')]);if(state.bottomTab!=='diagnostics'||state.bottomCollapsed)return;body.replaceChildren();
    if(results[0].status==='fulfilled'){const health=results[0].value;body.append(node('span','','Dashboard '+safe(health.status)+' · Database '+safe(health.database)+' · '+(health.read_only?'READ-ONLY':'read-only unknown')));}
    else body.append(node('span','wb-error-inline','Health unavailable.'));
    if(results[1].status==='fulfilled'){state.git=results[1].value;body.append(node('span','','Git '+(state.git.git_available?(state.git.entries||[]).length+' changed path(s)':'unavailable')));}
    else body.append(node('span','wb-error-inline','Git status unavailable.'));
    updateStatus();
  }
  function createDialog(id,title,placeholder){
    let dialog=$(id);if(dialog)return dialog;
    dialog=node('dialog','wb-dialog');dialog.id=id;dialog.setAttribute('aria-labelledby',id+'-title');
    const header=node('div','wb-dialog-head');header.append(node('h2','',title));
    const close=node('button','wb-small-action','×');close.type='button';close.setAttribute('aria-label','Close '+title);close.addEventListener('click',()=>dialog.close());header.append(close);
    const input=node('input','wb-dialog-input');input.type='search';input.placeholder=placeholder;input.setAttribute('aria-label',placeholder);
    const list=node('div','wb-dialog-results');list.setAttribute('role','listbox');list.id=id+'-results';dialog.append(header,input,list);document.body.append(dialog);
    dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
    dialog.addEventListener('keydown',event=>{if(event.key==='ArrowDown'&&event.target===input){const first=list.querySelector('button');if(first){event.preventDefault();first.focus();}}if(event.key==='Escape'&&dialog.open)dialog.close();});
    dialog._input=input;dialog._list=list;return dialog;
  }
  function openQuickOpen(){
    const dialog=createDialog('wb-quick-open','Quick Open','Search open and workspace files…');dialog._input.value='';if(!dialog.open)dialog.showModal();
    renderQuickOpenResults('',dialog._list);
    dialog._input.oninput=debounce(()=>renderQuickOpenResults(dialog._input.value.trim(),dialog._list),180);
    dialog._input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();dialog._list.querySelector('button')?.click();}};
    dialog._input.focus();
  }
  async function renderQuickOpenResults(query,host){
    const seq=++state.searchSequence;state.workspaceSearchSequence++;host.replaceChildren();
    state.openEditors.slice().reverse().filter(path=>!query||path.toLowerCase().includes(query.toLowerCase())).forEach(path=>{
      const item={path,kind:'file',recent:true};host.append(quickOpenButton(item,()=>{$('wb-quick-open').close();openEditor(item.path);}));
    });
    if(query.length>=2){
      host.append(node('div','wb-loading','Searching configured workspace…'));
      let matches;try{matches=await collectWorkspaceMatches(query,20);}catch(error){if(seq===state.searchSequence)host.append(node('div','wb-error-inline','Workspace search unavailable: '+error.message));return;}
      if(seq!==state.searchSequence||!$('wb-quick-open')?.open)return;
      host.querySelector('.wb-loading')?.remove();
      matches.items.forEach(item=>host.append(quickOpenButton(item,()=>{$('wb-quick-open').close();if(item.kind==='file')openEditor(item.path);else openWorkspaceFolder(item.path); })));
      if(matches.capped)note(host,'Search capped by workspace safety limits.','wb-search-limit');
    }
    if(!host.children.length)host.append(node('div','wb-empty-state',query?'No matching files.':'Type a file name or path. Recent open files appear here.'));
  }
  function quickOpenButton(item,action){
    const button=node('button','wb-quick-result');button.type='button';button.setAttribute('role','option');
    button.append(node('strong','',item.path),node('small','',item.recent?'Open editor':(item.kind==='directory'?'Folder · configured workspace':'File · configured workspace')));
    button.addEventListener('click',action);return button;
  }
  const commands=[
    ['Open Overview',()=>activateView('overview')],['Open Explorer',()=>activateView('files')],
    ['Open Global Search',()=>openUtility('search')],['Open Source Control',()=>activateSourceControl()],
    ['Open Workflows',()=>activateView('workflows')],['Open Roles & Skills',()=>activateView('roles')],
    ['Open Policies',()=>activateView('policies')],['Open Artifacts',()=>activateView('artifacts')],
    ['Open Batch Execution',()=>activateView('batches')],['Open Event Stream',()=>activateView('events')],
    ['Open Problems',()=>openUtility('problems')],['Open Diagnostics',()=>openUtility('diagnostics')],
    ['Refresh snapshot',()=>$('refresh-button')?.click()],['Refresh Git status',()=>refreshGitStatus()]
  ];
  function openCommandPalette(){
    const dialog=createDialog('wb-command-palette','Command Palette','Type a command…');dialog._input.value='';if(!dialog.open)dialog.showModal();
    const render=query=>{
      dialog._list.replaceChildren();const matches=commands.filter(([label])=>label.toLowerCase().includes(query.toLowerCase()));
      matches.forEach(([label,run])=>{const button=node('button','wb-quick-result',label);button.type='button';button.setAttribute('role','option');button.addEventListener('click',()=>{dialog.close();run();});dialog._list.append(button);});
      if(!matches.length)dialog._list.append(node('div','wb-empty-state','No matching commands.'));
    };
    render('');dialog._input.oninput=debounce(()=>render(dialog._input.value.trim()),80);
    dialog._input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();dialog._list.querySelector('button')?.click();}};dialog._input.focus();
  }
  function setupGlobalSearch(){const input=$('global-search');if(!input)return;input.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();openUtility('search',input.value.trim());}else if(event.key==='Escape')input.value='';});}
  function start(){
    setupActivityBar();setupChrome();setupExplorer();setupSourceControl();setupGlobalSearch();
    document.addEventListener('click',event=>{
      const button=event.target.closest('[data-workbench-action]');if(!button)return;
      const action=button.dataset.workbenchAction;
      if(action==='search')openUtility('search');else if(action==='quick-open')openQuickOpen();
      else if(action==='sourceControl')activateSourceControl();else if(action==='problems')openUtility('problems');
      else if(action==='diagnostics')openUtility('diagnostics');else if(action==='refresh-git')refreshGitStatus();
    });
    document.addEventListener('keydown',event=>{
      const typing=['INPUT','TEXTAREA','SELECT'].includes(document.activeElement&&document.activeElement.tagName);
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='p'&&!event.shiftKey){event.preventDefault();openQuickOpen();}
      else if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.key.toLowerCase()==='p'){event.preventDefault();openCommandPalette();}
      else if(event.key==='/'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!typing){event.preventDefault();$('global-search')?.focus();}
    });
    const refresh=$('file-refresh');if(refresh)refresh.addEventListener('click',()=>{state.treeLoaded=false;loadTreeRoot();});
    const mode=$('wb-diff-mode');if(mode)mode.addEventListener('change',()=>{state.diffMode=mode.value;if(state.selectedGit)showDiff(state.selectedGit,null,state.diffMode);});
    renderShell();renderOpenEditors();renderBottom();refreshGitStatus();
    const query=new URLSearchParams(window.location.search).get('q')||'',initial=new URLSearchParams(window.location.search).get('wb')||'';
    if(initial==='search')openUtility('search',query);else if(initial==='problems')openUtility('problems');
    else if(initial==='diagnostics')openUtility('diagnostics');else if(initial==='sourceControl')activateSourceControl();
    else if(initial==='explorer')activateView('files');
    const pre=$('file-preview-content');
    function renderLineNumbers(){
      if(!pre||pre.dataset.rendering==='true')return;
      const raw=pre.textContent;if(pre.dataset.rawText===raw&&pre.classList.contains('wb-editor-lines'))return;
      pre.dataset.rendering='true';pre.classList.add('wb-editor-lines');pre.replaceChildren();
      const lines=raw.split('\n');lines.forEach((line,index)=>{pre.append(node('span','wb-code-line',line));if(index<lines.length-1)pre.append(document.createTextNode('\n'));});
      pre.dataset.rawText=raw;pre.dataset.rendering='false';
    }
    if(pre){new MutationObserver(renderLineNumbers).observe(pre,{childList:true,subtree:true,characterData:true});renderLineNumbers();}
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();