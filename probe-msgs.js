// probe-msgs.js — dump last N user/assistant turns + whether last one is empty
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
    return Array.from(document.querySelectorAll('[data-message-author-role]')).map(m => ({
      role: m.getAttribute('data-message-author-role'),
      text: (m.innerText || '').trim().slice(0, 200),
      imgAlt: Array.from(m.querySelectorAll('img[alt]')).map(i => i.alt).slice(0,3)
    }));
  })()`,
  returnByValue: true
});
for (const m of (ev?.result?.value ?? [])) console.log(JSON.stringify(m));
ws.close(); process.exit(0);