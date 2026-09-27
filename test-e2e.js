// test-e2e.js — E2E benchmark for the ChatGPT Web Adapter
// Measures TTFT (time-to-first-token), chunk cadence, and total latency.
import http from 'node:http';

const BASE = 'http://127.0.0.1:8318';
const MODELS = ['chatgpt-free', 'chatgpt-coordinator', 'chatgpt-cto'];

function postJson(path, body, { stream = true } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(new URL(BASE + path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      if (stream) {
        resolve(parseStream(res));
      } else {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
          catch (e) { reject(new Error('Bad JSON: ' + data.slice(0, 200))); }
        });
      }
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function parseStream(res) {
  return new Promise((resolve) => {
    const state = {
      status: res.statusCode,
      chunks: [], chunkTimes: [], ttft: null, done: null, contentType: res.headers['content-type'],
      buffers: []
    };
    let buf = '';
    const startedAt = Date.now();
    res.on('data', (c) => {
      buf += c.toString();
      if (state.ttft === null && buf.includes('data: ') && !buf.includes('data: [DONE]')) {
        state.ttft = Date.now() - startedAt;
      }
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!raw.trim()) continue;
        for (const line of raw.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            state.done = Date.now() - startedAt;
            continue;
          }
          state.chunks.push({
            t: Date.now() - startedAt,
            content: (() => { try { return JSON.parse(data).choices?.[0]?.delta?.content || ''; } catch { return ''; } })()
          });
        }
      }
    });
    res.on('end', () => {
      state.chunkTimes = state.chunks.map(c => c.t);
      state.totalChunks = state.chunks.length;
      state.totalText = state.chunks.map(c => c.content).join('');
      state.ttft = state.ttft ?? state.done;
      resolve(state);
    });
    res.on('error', (e) => resolve(Object.assign(state, { fail: e.message })));
  });
}

function summarize(run, label) {
  const chunks = run.chunks;
  const sampleDeltas = [];
  for (let i = 1; i < chunks.length && i <= 12; i++) {
    sampleDeltas.push(chunks[i].t - chunks[i - 1].t);
  }
  console.log(`--- ${label} ---`);
  console.log(`  status:            ${run.status}`);
  if (run.fail) console.log(`  FAIL:              ${run.fail}`);
  console.log(`  TTFT:              ${run.ttft ?? '-'} ms`);
  console.log(`  total (to done):   ${run.done ?? '-'} ms`);
  console.log(`  chunks:            ${run.totalChunks}`);
  console.log(`  chars:             ${(run.totalText || '').length}`);
  console.log(`  inter-chunk deltas (first ${sampleDeltas.length}): ${sampleDeltas.join(', ')}`);
  if (run.nonStreamMs !== undefined) console.log(`  non-stream total:  ${run.nonStreamMs} ms`);
  console.log('');
}

async function main() {
  const model = process.argv[2] || 'chatgpt-free';
  const prompt = process.argv[3] || 'Trả lời 2 câu đúng sự thật, không liệt kê.';
  console.log(`E2E via adapter BASE=${BASE} model=${model}`);
  console.log(`prompt: ${prompt}\n`);

  // Warmup so composer/injection is warm before measuring.
  await postJson('/v1/chat/completions', {
    model, stream: true,
    messages: [{ role: 'user', content: 'Hi' }]
  });
  await new Promise(r => setTimeout(r, 1500));

  // 1. Streaming run.
  const run = await postJson('/v1/chat/completions', {
    model, stream: true,
    messages: [{ role: 'user', content: prompt }]
  });
  summarize(run, 'STREAM');

  // 2. Non-streaming run (same prompt) for end-to-end latency.
  const nsStart = Date.now();
  const ns = await postJson('/v1/chat/completions', {
    model, stream: false,
    messages: [{ role: 'user', content: prompt }]
  }, { stream: false });
  if (ns.json?.choices?.[0]?.message?.content) {
    run.nonStreamMs = Date.now() - nsStart;
  }
  summarize(run, 'STREAM (+ non-stream measured above)');
  console.log(`non-stream choices[0].finish_reason = ${ns.json?.choices?.[0]?.finish_reason}`);
}

main().catch(e => { console.error('E2E failed:', e.message); process.exit(1); });