// probe-tab.js — inspect a chatgpt tab's DOM state via CDP
const tid = process.argv[2];
if (!tid) { console.error('usage: node probe-tab.js <targetId>'); process.exit(1); }

const list = await (await fetch('http://127.0.0.1:9021/json/list')).json();
const t = list.find(x => x.id.startsWith(tid));
if (!t) { console.error('target not found'); process.exit(1); }

const ws = new WebSocket(t.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise(res => {
  const id = ++mid;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
await new Promise(r => ws.onopen = r);
const ev = await send('Runtime.evaluate', {
  expression: `(() => {
    const ta = document.querySelector('#prompt-textarea');
    const sendBtn = document.querySelector('button[data-testid="send-button"], button[data-testid="fruitjuice-send-button"]');
    const stopBtn = document.querySelector('button[data-testid="stop-button"]');
    const msgs = document.querySelectorAll('[data-message-author-role]').length;
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], div[aria-modal="true"]')).map(d => (d.innerText||'').slice(0,120));
    const banners = Array.from(document.querySelectorAll('[class*="banner"], [data-testid*="banner"]')).map(b => (b.innerText||'').slice(0,100));
    const statusInfo = document.querySelector('.status-info, [data-testid="status-info"]');
    return {
      url: location.href,
      hasComposer: !!ta,
      composerText: ta ? (ta.innerText||'').slice(0,80) : null,
      composerEditable: ta ? ta.isContentEditable : null,
      hasSendBtn: !!sendBtn && !sendBtn.disabled,
      hasStopBtn: !!stopBtn,
      msgCount: msgs,
      diagLayers: document.querySelectorAll('div[role="presentation"][class*="react"]').length,
      dialogs,
      banners,
      statusInfo: statusInfo ? statusInfo.innerText.slice(0,120) : null
    };
  })()`,
  returnByValue: true
});
console.log(JSON.stringify(ev?.result?.value ?? ev, null, 2));
ws.close();
process.exit(0);