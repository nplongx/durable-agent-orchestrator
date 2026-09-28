// test-multi-account.js — Test suite for Multi-Account Rotation, Cooldown, and Circuit Breaker
import assert from 'node:assert';
import { MultiAccountChatGPTBridge } from '../cdp.js';

console.log('========================================================');
console.log('🧪 BẮT ĐẦU KIỂM THỬ: MULTI-ACCOUNT ROTATION & COOLDOWN & CIRCUIT BREAKER');
console.log('========================================================\n');

// 1. Mock Accounts Test
class MockTabWorker {
  constructor(name, shouldFailRateLimit = false) {
    this.name = name;
    this.shouldFailRateLimit = shouldFailRateLimit;
    this.targetId = 'mock-' + name;
    this.ready = true;
  }
  async ensureConnected() {}
  async ask(prompt) {
    if (this.shouldFailRateLimit) {
      throw new Error('⚠️ [ChatGPT Bridge] ChatGPT Rate Limit: Tài khoản đang bị giới hạn tạm thời (rate_limit_hard_block).');
    }
    return `[${this.name}] Phản hồi cho: ${prompt.slice(0, 30)}`;
  }
}

class MockAccountBridge {
  constructor(name, port, shouldFailRateLimit = false) {
    this.name = name;
    this.port = port;
    this.shouldFailRateLimit = shouldFailRateLimit;
    this.worker = new MockTabWorker(name, shouldFailRateLimit);
  }
  normalizeRole(r) { return r || 'coordinator'; }
  async isCdpAvailable() { return true; }
  async getTargets() { return [{ id: 'tab-' + this.name, url: 'https://chatgpt.com' }]; }
  async prewarm() {}
  getStatus() {
    return { ready: true, name: this.name, port: this.port };
  }
  async ask(prompt, onChunk, timeoutMs, role, priority) {
    return await this.worker.ask(prompt);
  }
}

// Subclass MultiAccountChatGPTBridge for unit testing mock bridges
class TestableMultiAccountBridge extends MultiAccountChatGPTBridge {
  constructor(options = {}) {
    super({ ...options, cooldownMs: 500 }); // 500ms cooldown for fast test
    // Replace underlying bridges with mocks
    for (let i = 0; i < this.accounts.length; i++) {
      const acc = this.accounts[i];
      acc.bridge = new MockAccountBridge(acc.name, acc.port, options.rateLimitAccounts?.includes(acc.id));
    }
  }
}

async function runTests() {
  console.log('--- TEST 1: Khởi tạo Pool 4 Accounts ---');
  const pool = new TestableMultiAccountBridge();
  const status = pool.getStatus();
  assert.strictEqual(status.totalAccounts, 4, 'Pool phải có đúng 4 tài khoản');
  assert.strictEqual(status.accounts.length, 4, 'Danh sách accounts phải có 4 phần tử');
  console.log('✅ TEST 1 ĐẠT: Khởi tạo thành công 4 accounts trong Pool!');

  console.log('\n--- TEST 2: Account-Level Serialization & Control-Plane Pacing ---');
  // Request 1 -> Account 1
  const t0 = Date.now();
  const res1 = await pool.ask('Yêu cầu 1');
  assert(res1.includes('Account 1'), 'Yêu cầu 1 phải vào Account 1');
  console.log(`✓ Request 1 xử lý bởi: ${res1.split(']')[0]}]`);

  // Control-plane traffic stays pinned to Account 1, but is serialized instead
  // of creating concurrent requests on the same ChatGPT account.
  const res2 = await pool.ask('Yêu cầu 2');
  assert(res2.includes('Account 1'), 'Control-plane request 2 phải chờ Account 1 thay vì chạy đồng thời');
  console.log(`✓ Request 2 xử lý bởi: ${res2.split(']')[0]}] (đã serialize theo account)`);

  // Specialist traffic can still use independent healthy accounts.
  const res3 = await pool.ask('Yêu cầu 3', null, 180000, 'qa');
  assert(res3.includes('Account 2'), 'Specialist request phải tận dụng account độc lập khi Account 1 đang pacing');
  console.log(`✓ QA request xử lý bởi: ${res3.split(']')[0]}]`);

  // Request 4 -> control-plane stays on Account 1.
  const res4 = await pool.ask('Yêu cầu 4');
  assert(res4.includes('Account 1'), 'Control-plane request vẫn phải về Account 1');
  console.log(`✓ Request 4 xử lý bởi: ${res4.split(']')[0]}]`);

  const elapsed = Date.now() - t0;
  console.log(`⏱️ Chuỗi control-plane serialize: ${elapsed}ms`);
  assert(elapsed >= 500, 'Control-plane phải tôn trọng pacing cooldown');
  console.log('✅ TEST 2 ĐẠT: Account-level serialization + control-plane pacing hoạt động!');

  console.log('\n--- TEST 2B: Concurrent requests không được cùng chiếm một account ---');
  const concurrentPool = new TestableMultiAccountBridge({ cooldownMs: 1 });
  const seen = [];
  for (const acc of concurrentPool.accounts) {
    const original = acc.bridge.ask.bind(acc.bridge);
    acc.bridge.ask = async (...args) => {
      seen.push({ account: acc.id, active: acc.activeRequests, reserved: acc.reservedRequests });
      await new Promise(resolve => setTimeout(resolve, 30));
      return original(...args);
    };
  }
  await Promise.all([
    concurrentPool.ask('parallel-a', null, 180000, 'qa'),
    concurrentPool.ask('parallel-b', null, 180000, 'qa'),
    concurrentPool.ask('parallel-c', null, 180000, 'qa')
  ]);
  assert(seen.every(x => x.active <= 1), 'Không được có account nào có >1 active request');
  console.log(`✓ Concurrent requests observed: ${seen.map(x => `A${x.account}:active=${x.active}`).join(', ')}`);
  console.log('✅ TEST 2B ĐẠT: Không còn selection race gây concurrent burst trên cùng account!');

  console.log('\n--- TEST 3: Tự động Failover khi Account 1 bị Rate Limit ---');
  // Create a pool where Account 1 is rate limited
  const failoverPool = new TestableMultiAccountBridge({
    rateLimitAccounts: [1], // Account 1 will throw rate_limit_hard_block
    rateLimitCooldownMs: 60000
  });

  const failoverRes = await failoverPool.ask('Task quan trọng của Boss');
  assert(failoverRes.includes('Account 2'), 'Khi Account 1 bị Rate Limit, hệ thống phải tự chuyển sang Account 2');
  console.log(`✓ Kết quả failover: ${failoverRes.split(']')[0]}] (Account 1 bị chặn -> Account 2 cứu nguy thành công!)`);

  const failoverStatus = failoverPool.getStatus();
  assert.strictEqual(failoverStatus.accounts[0].isRateLimited, true, 'Account 1 phải được đánh dấu isRateLimited = true');
  assert.strictEqual(failoverStatus.accounts[1].isRateLimited, false, 'Account 2 vẫn hoạt động bình thường');
  console.log('✅ TEST 3 ĐẠT: Tự động phát hiện rate_limit_hard_block và failover sang account tiếp theo!');

  console.log('\n--- TEST 4: Báo cáo khi TOÀN BỘ 4 Accounts đều bị Rate Limit ---');
  const allBlockedPool = new TestableMultiAccountBridge({
    rateLimitAccounts: [1, 2, 3, 4],
    rateLimitCooldownMs: 1200000 // 20 phút
  });

  let errorCaught = null;
  try {
    await allBlockedPool.ask('Task khi cạn sạch quota');
  } catch (e) {
    errorCaught = e.message;
  }
  assert(errorCaught !== null, 'Phải ném lỗi khi cạn toàn bộ accounts');
  assert(errorCaught.includes('Toàn bộ 4 tài khoản'), 'Lỗi phải nêu rõ toàn bộ 4 tài khoản đều bị Rate Limit');
  assert(errorCaught.includes('phục hồi sau ~'), 'Lỗi phải có thời gian phục hồi dự kiến');
  console.log(`✓ Thông điệp ngắt mạch chính xác: ${errorCaught}`);
  console.log('✅ TEST 4 ĐẠT: Cảnh báo chính xác khi toàn bộ 4 accounts bị hạn chế!');

  console.log('\n========================================================');
  console.log('🎉 TẤT CẢ 4/4 BÀI TEST MULTI-ACCOUNT & COOLDOWN ĐỀU ĐẠT 100%!');
  console.log('========================================================');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
