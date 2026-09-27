// probe-model.js — find active model + thinking state on a tab
const tid = process.argv[2];
const list = await (await fetch('http://127.0.0.1:9021/json/list')).json();
const t = list.find(x => x.id.startsWith(tid));
const ws = new WebSocket(t.webSocketDebuggerUrl);
let mid = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(res => { const id = ++mid; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await new Promise(r => ws.onopen = r);
const ev = await send('Runtime.evaluate', {
  expression: `(() => {
    const last = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')).pop();
    const copy = last ? Array.from(last.querySelectorAll('button[data-testid*="copy"], button[aria-label*="[Copy"]')).length : 0;
    const md = last ? (last.querySelector('.markdown')||last) : null;
    // top model picker
    const picker = document.querySelector('[data-testid="model-selector-button"], .model-selector, [data-testid="composer-model-selector"], .min-w-0.max-w-full.flex-1');
    return {
      lastTextLen: last ? (last.innerText||'').length : -1,
      hasCopyBtn: copy,
      markdownExists: !!md,
      modelHtml: picker ? picker.outerHTML.slice(0, 400) : null,
      anyThinking: !!last && !!last.querySelector('.result-thinking, .result-streaming'),
      busy: !!document.querySelector('button[data-testid="stop-button"], [aria-busy="true"], .result-streaming')
    };
  })()`,
  returnByValue: true
});
console.log(JSON.stringify(ev?.result?.value ?? ev, null, 2));
ws.close(); process.exit(0);