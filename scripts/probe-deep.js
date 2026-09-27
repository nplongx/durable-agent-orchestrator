// probe-deep.js — deep inspect last assistant turn + model info + busy state
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
    if (!last) return { none: true };
    const turn = last.closest('article, [data-testid*="turn"]') || last.parentElement;
    const summary = {
      msgHtmlClasses: last.className,
      thinking: Array.from(last.querySelectorAll('*')).filter(e => (e.className||'').toString().includes('thinking') || (e.getAttribute('data-testid')||'').includes('thinking')).length,
      resultStreaming: !!last.querySelector('.result-streaming'),
      textLen: (last.innerText||'').length,
      htmlSnippet: last.innerHTML.slice(0, 500)
    };
    const modelEl = document.querySelector('[data-testid="conversation-title"], .model-selector-button, [data-testid="model-selector-button"], .text-token-text');
    return {
      ...summary,
      modelText: modelEl ? (modelEl.innerText||modelEl.textContent||'').trim().slice(0,80) : null,
      busy: !!document.querySelector('[aria-busy="true"], .result-streaming, .result-thinking, button[data-testid="stop-button"]')
    };
  })()`,
  returnByValue: true
});
console.log(JSON.stringify(ev?.result?.value ?? ev, null, 2));
ws.close(); process.exit(0);