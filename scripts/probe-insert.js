// probe-insert.js — raw Input.insertText test on a tab
const tid = process.argv[2];
const list = await (await fetch('http://127.0.0.1:9021/json/list')).json();
const t = list.find(x => x.id.startsWith(tid));
if (!t) { console.error('not found'); process.exit(1); }
const ws = new WebSocket(t.webSocketDebuggerUrl);
let mid = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
const send = (method, params = {}, ms = 6000) => new Promise((res, rej) => {
  const id = ++mid;
  const timer = setTimeout(() => { pending.delete(id); rej(new Error(method + ' timeout')); }, ms);
  pending.set(id, (r) => { clearTimeout(timer); res(r); });
  try { ws.send(JSON.stringify({ id, method, params })); } catch (e) { clearTimeout(timer); rej(e); }
});
await new Promise(r => ws.onopen = r);
try { await send('Runtime.enable'); await send('Page.enable'); await send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch {}
// focus editor
const f = await send('Runtime.evaluate', { expression: `(() => {
  const ta = document.querySelector('#prompt-textarea');
  if (!ta) return {has:false};
  ta.focus();
  return {has:true, editable:ta.isContentEditable, focused: document.activeElement===ta, hidden: ta.offsetParent===null};
})()`, returnByValue: true });
const fi = f.result?.value;
if (!fi || !fi.has) { console.log('NO EDITOR:', JSON.stringify(fi)); ws.close(); process.exit(0); }
console.log('editor state:', JSON.stringify(fi));
const t0 = Date.now();
try {
  await send('Input.insertText', { text: 'xinchao' });
  console.log('insertText OK in', Date.now() - t0, 'ms');
} catch (e) { console.log('insertText FAIL:', e.message, 'after', Date.now() - t0, 'ms'); }
const v = await send('Runtime.evaluate', { expression: `(() => {
  const ta = document.querySelector('#prompt-textarea');
  return ta ? (ta.innerText||'').trim().slice(0,40) : 'NO_TA';
})()`, returnByValue: true });
console.log('composer now:', JSON.stringify(v.result?.value));
ws.close(); process.exit(0);