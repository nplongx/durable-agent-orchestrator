// cdp.js — Multi-Tab Chrome DevTools Protocol client for ChatGPT Web
import { spawn } from 'node:child_process';

function abortableDelay(ms, signal) {
  if (signal?.aborted) return Promise.reject(new Error('Request aborted by caller'));
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('Request aborted by caller'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function awaitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('Request aborted by caller'));
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const onAbort = () => reject(new Error('Request aborted by caller'));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => {});
    })
  ]);
}

export class TabWorker {
  constructor(role, bridge, target) {
    this.role = role;
    this.bridge = bridge;
    this.target = target;
    this.targetId = target.id;
    this.ws = null;
    this.messageId = 1;
    this.pendingCallbacks = new Map();
    this.queue = [];
    this.processing = false;
    this.ready = false;
    this.connectingPromise = null;
    this.lastActive = Date.now();
    this.lastRecycleAt = 0;
  }

  // Try to recycle: close the wedged tab and move this role to a fresh tab.
  async forceRefreshTarget(signal = null) {
    if (signal?.aborted) throw new Error('Request aborted by caller');
    console.warn(`[CDP:${this.role}] Wedged tab ${this.targetId} - closing and recycling to a fresh tab...`);
    this.lastRecycleAt = Date.now();
    const closedTargetId = this.targetId;
    // Create replacement first. Closing the only page can make Chrome exit,
    // taking the CDP port down and turning a tab recovery into a browser restart.
    const fresh = await this.bridge.createNewTab('https://chatgpt.com', signal);
    let committed = false;
    if (signal?.aborted) {
      try { await fetch(`${this.bridge.cdpBaseUrl}/json/close/${fresh.id}`); } catch {}
      throw new Error('Request aborted by caller');
    }
    try {
      if (this.bridge && this.targetId) {
        try { await fetch(`${this.bridge.cdpBaseUrl}/json/close/${this.targetId}`, { signal }); } catch (err) {
          if (signal?.aborted) throw new Error('Request aborted by caller');
        }
      }
      // /json/close is asynchronous. Do not immediately reacquire: Chrome can
      // still advertise the closing target briefly, causing recycle to select
      // the same stale target again.
      const closeWaitStart = Date.now();
      while (Date.now() - closeWaitStart < 5000) {
        if (signal?.aborted) throw new Error('Request aborted by caller');
        try {
          const targets = await this.bridge.getTargets(signal);
          if (!targets.some(t => t.id === closedTargetId)) break;
        } catch (err) {
          if (signal?.aborted) throw err;
        }
        await abortableDelay(150, signal);
      }
      if (signal?.aborted) throw new Error('Request aborted by caller');
      this.resetConnection('recycling wedged tab');
      this.target = fresh;
      this.targetId = fresh.id;
      committed = true;
      console.log(`[CDP:${this.role}] Recycled to fresh tab ${fresh.id.slice(0, 14)}...`);
      // acquireTarget() only returns a CDP target; it does not guarantee the
      // ChatGPT React composer has mounted. Give a recycled tab time to mount
      // before the injection loop probes it again.
      await abortableDelay(5000, signal);
    } finally {
      if (!committed) {
        try { await fetch(`${this.bridge.cdpBaseUrl}/json/close/${fresh.id}`); } catch {}
      }
    }
  }

  resetConnection(reason = 'connection reset', expectedConnectingPromise = null) {
    console.log(`[CDP:${this.role}] Resetting connection (${reason})...`);
    this.ready = false;
    if (!expectedConnectingPromise || this.connectingPromise === expectedConnectingPromise) {
      this.connectingPromise = null;
    }
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    for (const [id, cb] of this.pendingCallbacks.entries()) {
      cb.reject(new Error(`WebSocket reset (${reason}) while waiting for response to message ${id}`));
    }
    this.pendingCallbacks.clear();
  }

  async ensureConnected(signal = null) {
    if (signal?.aborted) throw new Error('Request aborted by caller');
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.ready) {
      return;
    }
    if (this.connectingPromise) {
      return awaitWithSignal(this.connectingPromise, signal);
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const connecting = (async () => {
        // Verify if target still exists or acquire a new one
        const targets = await this.bridge.getTargets(signal);
        if (signal?.aborted) throw new Error('Request aborted by caller');
        let currentTarget = targets.find(t => t.id === this.targetId);
        if (!currentTarget) {
          console.log(`[CDP:${this.role}] Target ${this.targetId} disappeared, acquiring new target...`);
          currentTarget = await this.bridge.acquireTarget(this.role, signal);
          if (signal?.aborted) throw new Error('Request aborted by caller');
          this.target = currentTarget;
          this.targetId = currentTarget.id;
        }

        if (!currentTarget.webSocketDebuggerUrl) {
          throw new Error(`Target ${this.targetId} has no webSocketDebuggerUrl`);
        }

        return new Promise((resolve, reject) => {
          console.log(`[CDP:${this.role}] Connecting WebSocket to tab ${this.targetId}...`);
          const ws = new WebSocket(currentTarget.webSocketDebuggerUrl);
          this.ws = ws;
          let settled = false;

          const cleanupConnect = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
          };
          const resolveConnect = () => {
            if (settled) return;
            settled = true;
            cleanupConnect();
            resolve();
          };
          const rejectConnect = (err) => {
            if (settled) return;
            settled = true;
            cleanupConnect();
            reject(err);
          };
          const onAbort = () => {
            try { ws.close(); } catch {}
            rejectConnect(new Error('Request aborted by caller'));
          };

          const timer = setTimeout(() => {
            rejectConnect(new Error(`WebSocket connection timeout to tab ${this.targetId}`));
          }, 10000);
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener('abort', onAbort, { once: true });

          ws.onopen = async () => {
            console.log(`[CDP:${this.role}] ws.onopen triggered for ${this.targetId}`);
            try {
              if (signal?.aborted) throw new Error('Request aborted by caller');
              await this.sendRaw('Runtime.enable');
              await this.sendRaw('Page.enable');
              if (signal?.aborted) throw new Error('Request aborted by caller');
              this.ready = true;
              console.log(`[CDP:${this.role}] Tab ${this.targetId} connected and initialized for role '${this.role}'.`);
              resolveConnect();
            } catch (e) {
              console.error(`[CDP:${this.role}] ws.onopen failed:`, e);
              rejectConnect(e);
            }
          };

          ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.id) {
              console.log(`[CDP:${this.role}] <- recv id=${msg.id} hasCallback=${this.pendingCallbacks.has(msg.id)}`);
            }
            if (msg.id && this.pendingCallbacks.has(msg.id)) {
              const cb = this.pendingCallbacks.get(msg.id);
              this.pendingCallbacks.delete(msg.id);
              if (msg.error) {
                cb.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
              } else {
                cb.resolve(msg.result);
              }
            }
          } catch (err) {
            console.error(`[CDP:${this.role}] Message parse error:`, err);
          }
        };

          ws.onerror = (err) => {
            console.error(`[CDP:${this.role}] WebSocket error on tab ${this.targetId}:`, err);
            this.ready = false;
            if (this.connectingPromise === connecting) this.connectingPromise = null;
            rejectConnect(err);
          };

        ws.onclose = () => {
          console.log(`[CDP:${this.role}] WebSocket closed on tab ${this.targetId}.`);
          this.ws = null;
          this.ready = false;
          if (this.connectingPromise === connecting) this.connectingPromise = null;
          for (const [id, cb] of this.pendingCallbacks.entries()) {
            cb.reject(new Error(`WebSocket closed while waiting for response to message ${id}`));
          }
          this.pendingCallbacks.clear();
        };
      });
    })();

    this.connectingPromise = connecting;
    try {
      await awaitWithSignal(connecting, signal);
      return;
    } catch (e) {
      console.error(`[CDP:${this.role}] Connect attempt ${attempt + 1} failed: ${e.message}`);
      this.resetConnection('connect attempt failed', connecting);
      if (attempt === 0 && e.message.includes('timed out') && Date.now() - this.lastRecycleAt > 30000) {
        await this.forceRefreshTarget(signal);
        continue;
      }
      throw e;
    } finally {
      if (this.connectingPromise === connecting) {
        this.connectingPromise = null;
      }
    }
  }
  }

  sendRaw(method, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (this.currentItem?.signal?.aborted) {
        return reject(new Error('Request aborted by caller'));
      }
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error(`WebSocket not connected for role ${this.role}`));
      }
      const id = this.messageId++;
      const timer = setTimeout(() => {
        if (this.pendingCallbacks.has(id)) {
          this.pendingCallbacks.delete(id);
          const err = new Error(`CDP command ${method} (id=${id}) timed out after ${timeoutMs}ms`);
          this.resetConnection(`Command ${method} (id=${id}) timed out`);
          reject(err);
        }
      }, timeoutMs);

      this.pendingCallbacks.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });

      try {
        console.log(`[CDP:${this.role}] -> sendRaw ${method} id=${id}`);
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (sendErr) {
        clearTimeout(timer);
        this.pendingCallbacks.delete(id);
        this.resetConnection(`WebSocket send failed: ${sendErr.message}`);
        reject(sendErr);
      }
    });
  }

  async evaluate(expression, timeoutMs = 10000, awaitPromise = false) {
    await this.ensureConnected(this.currentItem?.signal || null);
    const res = await this.sendRaw('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise
    }, timeoutMs);
    if (res?.exceptionDetails) {
      const desc = [res.exceptionDetails.text, res.exceptionDetails.exception?.description]
        .filter(Boolean)
        .join(': ');
      const frames = res.exceptionDetails.exception?.stackTrace?.callFrames || [];
      const topFrame = frames[0] ? ` @ ${frames[0].functionName || '<anon>'}:${frames[0].lineNumber + 1}:${frames[0].columnNumber + 1}` : '';
      throw new Error(`Evaluation exception: ${desc}${topFrame}`);
    }
    return res?.result?.value;
  }

  async dismissModals() {
    const expr = `(() => {
      // 1. Dismiss Dialogs & Popovers (Rate limit, cookie, update, voice mode, project popups)
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], .popover, [data-state="open"], div[aria-modal="true"]'));
      let dismissed = false;

      for (const dialog of dialogs) {
        // Look for common dismissal buttons
        const dismissBtns = Array.from(dialog.querySelectorAll('button, a')).filter(b => {
          const txt = (b.innerText || '').toLowerCase().trim();
          const aria = (b.getAttribute('aria-label') || '').toLowerCase().trim();
          return (
            txt.includes('đã hiểu') || txt.includes('i understand') || txt.includes('got it') ||
            txt.includes('đóng') || txt.includes('close') || txt.includes('ok') ||
            txt.includes('not now') || txt.includes('maybe later') || txt.includes('bỏ qua') ||
            txt.includes('hủy') || txt.includes('cancel') || txt.includes('stay logged out') ||
            aria.includes('close') || aria.includes('đóng')
          );
        });

        if (dismissBtns.length > 0) {
          dismissBtns[0].click();
          dismissed = true;
        }
      }

      // 2. Global Close/Dismiss buttons that might float above
      const floatingClose = document.querySelector('button[aria-label="Close"], button[aria-label="Đóng"], button[data-testid="close-button"]');
      if (floatingClose && floatingClose.offsetParent !== null) {
        floatingClose.click();
        dismissed = true;
      }

      // 3. Remove blocking backdrops if stuck
      const backdrops = document.querySelectorAll('div[data-state="open"][class*="backdrop"], div.fixed.inset-0.bg-black\\\\/50');
      for (const b of backdrops) {
        b.style.pointerEvents = 'none';
      }

      return { dismissed };
    })()`;
    try {
      await this.evaluate(expr);
    } catch {
      // ignore modal dismiss errors
    }
  }

  // Cycle to a REGULAR fresh conversation (home + new-chat button). Avoids
  // '?temporary-chat=true': free-tier WEB: transient chats frequently return
  // "Something went wrong." / stall mid-generation, poisoning the tab's session.
  async navigateFreshChat(signal = null) {
    if (signal?.aborted) throw new Error('Request aborted by caller');
    console.log(`[CDP:${this.role}] Cycling to a fresh regular chat...`);
    try {
      // 1. First attempt: click New Chat button inside SPA (instant, keeps DOM connection intact)
      const clicked = await this.evaluate(`(() => {
        const btn = document.querySelector('[data-testid="create-new-chat-button"], a[aria-label*="chat"], a[aria-label*="đoạn chat"], a[href="/"]');
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      })()`, 3000).catch(() => false);

      if (clicked) {
        const start = Date.now();
        while (Date.now() - start < 2500) {
          const isClean = await this.evaluate(`(() => {
            const msgs = document.querySelectorAll('[data-message-author-role="assistant"], [data-message-author-role="user"]');
            const ta = document.querySelector('#prompt-textarea, div[contenteditable="true"]');
            const text = ta ? (ta.innerText || ta.textContent || '').trim() : '';
            return msgs.length === 0 && (window.location.pathname === '/' || !window.location.pathname.startsWith('/c/')) && !!ta && text.length === 0;
          })()`, 2000).catch(() => false);
          if (isClean) {
            console.log(`[CDP:${this.role}] Reset to fresh chat succeeded via in-app button.`);
            await this.dismissModals();
            return;
          }
          await abortableDelay(150, signal);
        }
      }

      // 2. Fallback: Page.navigate to root
      await this.sendRaw('Page.navigate', { url: 'https://chatgpt.com/' }, 5000).catch(() => {});
      await abortableDelay(2000, signal);
      const fresh = await this.evaluate(`(() => {
        const n = document.querySelectorAll('[data-message-author-role="assistant"], [data-message-author-role="user"]').length;
        const ta = document.querySelector('#prompt-textarea, div[contenteditable="true"]');
        const text = ta ? (ta.innerText || ta.textContent || '').trim() : '';
        if (n === 0 && ta && text.length === 0) return true;
        const btn = document.querySelector('[data-testid="create-new-chat-button"], a[href="/"], [data-testid="navigation-new-chat-button"]');
        if (btn) { btn.click(); }
        return false;
      })()`, 4000).catch(() => false);
      if (!fresh) {
        const navStart = Date.now();
        while (Date.now() - navStart < 4000) {
          const st = await this.evaluate(`(() => {
            const n = document.querySelectorAll('[data-message-author-role="assistant"], [data-message-author-role="user"]').length;
            const ta = document.querySelector('#prompt-textarea, div[contenteditable="true"]');
            const text = ta ? (ta.innerText || ta.textContent || '').trim() : '';
            return n === 0 && !!ta && text.length === 0;
          })()`, 3000).catch(() => false);
          if (st) break;
          await abortableDelay(150, signal);
        }
      }
    } catch (e) {
      console.error(`[CDP:${this.role}] Fresh-chat navigation error:`, e.message);
    }
    if (signal?.aborted) throw new Error('Request aborted by caller');
    await this.dismissModals();
  }

  ask(prompt, onChunk = null, timeoutMs = 180000, priority = 2, callerRole = null, signal = null) {
    return new Promise((resolve, reject) => {
      const roleLabel = callerRole || this.role;
      const item = {
        prompt,
        onChunk,
        timeoutMs,
        priority,
        role: roleLabel,
        resolve,
        reject,
        signal,
        cancelled: Boolean(signal?.aborted),
        emittedAny: false,
        queuedAt: Date.now()
      };
      if (item.cancelled) return reject(new Error('Request aborted by caller'));
      const onAbort = () => {
        item.cancelled = true;
        if (this.processing && this.currentItem === item) this.resetConnection('request aborted by caller');
        else { const idx = this.queue.indexOf(item); if (idx >= 0) this.queue.splice(idx, 1); }
        reject(new Error('Request aborted by caller'));
      };
      item.abortHandler = onAbort;
      signal?.addEventListener('abort', onAbort, { once: true });

      // Insert into priority queue: lower priority number = higher urgency (P0 > P1 > P2)
      let inserted = false;
      for (let i = 0; i < this.queue.length; i++) {
        if (priority < this.queue[i].priority) {
          this.queue.splice(i, 0, item);
          inserted = true;
          break;
        }
      }
      if (!inserted) {
        this.queue.push(item);
      }

      console.log(`[CDP:${this.role}] Enqueued prompt for role '${roleLabel}' [P${priority}] (queue length: ${this.queue.length})`);
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const item = this.queue.shift();
    this.currentItem = item;
    const waitTime = Date.now() - item.queuedAt;
    console.log(`[CDP:${this.role}] Processing prompt for '${item.role}' [P${item.priority}] (waited in queue: ${waitTime}ms)...`);
    const emitChunk = (chunk) => {
      if (chunk) item.emittedAny = true;
      item.onChunk?.(chunk);
    };

    try {
      if (item.cancelled || item.signal?.aborted) throw new Error('Request aborted by caller');
      const result = await this._executePrompt(item.prompt, emitChunk, item.timeoutMs, item.signal);
      this.lastActive = Date.now();
      item.resolve(result);
    } catch (err) {
      console.error(`[CDP:${this.role}] Execution error:`, err.message);
      if (item.cancelled || item.signal?.aborted) {
        item.reject(new Error('Request aborted by caller'));
        return;
      }
      if (err.message.includes('STALL_RECOVERY') && !item.retried && !item.emittedAny) {
        // Phantom-generation recovery: the tab was "generating" a long time with no output.
        // We already navigated it to a fresh chat; re-run the whole prompt once on the clean tab.
        console.warn(`[CDP:${this.role}] Re-running prompt on recovered tab...`);
        item.retried = true;
        try {
          const retryResult = await this._executePrompt(item.prompt, emitChunk, item.timeoutMs, item.signal);
          this.lastActive = Date.now();
          item.resolve(retryResult);
          return;
        } catch (retryErr) {
          console.error(`[CDP:${this.role}] Recovered retry also failed:`, retryErr.message);
          item.reject(retryErr);
          return;
        }
      }
      if (!item.retried && !item.emittedAny && (err.message.includes('timed out') || err.message.includes('WebSocket') || err.message.includes('not connected') || err.message.includes('not ready') || err.message.includes('Could not inject') || err.message.includes('Composer text not confirmed'))) {
        console.warn(`[CDP:${this.role}] Retrying prompt once after transient error: ${err.message}...`);
        item.retried = true;
        if (err.message.includes('not ready') || err.message.includes('timed out') || err.message.includes('Could not inject')) {
          console.warn(`[CDP:${this.role}] Error indicates wedged tab (${err.message}). Force recycling tab before retry...`);
          try {
            await this.forceRefreshTarget(item.signal);
          } catch (recErr) {
            if (item.signal?.aborted) throw recErr;
            console.error(`[CDP:${this.role}] forceRefreshTarget failed:`, recErr.message);
            this.resetConnection(`Retrying prompt after error: ${err.message}`);
          }
        } else {
          this.resetConnection(`Retrying prompt after error: ${err.message}`);
        }
        try {
          const retryResult = await this._executePrompt(item.prompt, emitChunk, item.timeoutMs, item.signal);
          this.lastActive = Date.now();
          item.resolve(retryResult);
          return;
        } catch (retryErr) {
          console.error(`[CDP:${this.role}] Retry also failed:`, retryErr.message);
          item.reject(retryErr);
          return;
        }
      }
      item.reject(err);
    } finally {
      item.signal?.removeEventListener('abort', item.abortHandler);
      if (this.currentItem === item) this.currentItem = null;
      this.processing = false;
      this.processQueue();
    }
  }

  async _executePrompt(prompt, onChunk, timeoutMs, signal = null) {
    const throwIfAborted = () => {
      if (signal?.aborted) throw new Error('Request aborted by caller');
    };
    throwIfAborted();
    await this.ensureConnected(signal);
    throwIfAborted();
    await this.dismissModals();
    throwIfAborted();

    // 0. Wake tab and activate focus to prevent Chrome background tab throttling
    try {
      throwIfAborted();
      await this.sendRaw('Page.bringToFront', {}, 5000);
      await this.sendRaw('Emulation.setFocusEmulationEnabled', { enabled: true }, 5000);
    } catch {}

    // 1. Cycle to a fresh chat for every prompt to ensure clean DOM and fast response.
    //    OpenClaw passes full conversational history in the prompt, so keeping old turns
    //    in the Web DOM only causes memory bloat, slower rendering, and composer state bugs.
    try {
      const threadState = await this.evaluate(`(() => {
        const msgs = document.querySelectorAll('[data-message-author-role="assistant"], [data-message-author-role="user"]');
        return {
          msgCount: msgs.length,
          isSubpath: window.location.pathname.startsWith('/c/')
        };
      })()`, 4000);

      if (threadState && (threadState.msgCount > 0 || threadState.isSubpath)) {
        throwIfAborted();
        console.log(`[CDP:${this.role}] Resetting to fresh chat for clean turn (msgCount: ${threadState.msgCount})...`);
        await this.navigateFreshChat(signal);
        await this.dismissModals();
      }
    } catch (e) {
      console.warn(`[CDP:${this.role}] Thread check notice:`, e.message);
    }

    // 2. Wait until composer (#prompt-textarea) is ready and focused (with active auto-recovery)
    const composerStart = Date.now();
    let composerReady = false;
    let attemptedEscape = false;
    let attemptedRecovery = false;
    let attemptedRecycle = false;
    let consecutiveEvalErrors = 0;

    while (Date.now() - composerStart < 35000) {
      throwIfAborted();
      await this.dismissModals();

      let ready = false;
      try {
        ready = await this.evaluate(`(() => {
          const ta = document.querySelector('#prompt-textarea, div[contenteditable="true"][tabindex="0"], div[contenteditable="true"]');
          if (ta && ta.isContentEditable && ta.offsetParent !== null) {
            ta.focus();
            return true;
          }
          return false;
        })()`, 4000);
        consecutiveEvalErrors = 0;
      } catch (err) {
        consecutiveEvalErrors++;
        console.warn(`[CDP:${this.role}] Composer poll evaluate warning (${consecutiveEvalErrors}):`, err.message);
        if (consecutiveEvalErrors >= 2 && !attemptedRecycle) {
          attemptedRecycle = true;
          console.warn(`[CDP:${this.role}] Consecutive evaluate timeouts on tab. Force recycling tab immediately...`);
          try {
            await this.forceRefreshTarget(signal);
            await this.ensureConnected(signal);
          } catch (recErr) {
            if (signal?.aborted) throw recErr;
            console.error(`[CDP:${this.role}] Auto-recovery recycle error:`, recErr.message);
          }
          consecutiveEvalErrors = 0;
        }
      }

      if (ready) {
        composerReady = true;
        break;
      }

      const elapsed = Date.now() - composerStart;

      // Auto-recovery 1: After 5s, dispatch Escape key to close any hidden context menus or modal backdrops
      if (elapsed > 5000 && !attemptedEscape) {
        attemptedEscape = true;
        console.log(`[CDP:${this.role}] Composer taking >5s, dispatching Escape key...`);
        try {
          await this.sendRaw('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, 2000);
          await this.sendRaw('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, 2000);
        } catch {}
      }

      // Auto-recovery 2: If still not ready after 10s, auto-recover by navigating fresh
      if (elapsed > 10000 && !attemptedRecovery) {
        attemptedRecovery = true;
        console.warn(`[CDP:${this.role}] Composer not ready after 10s. Auto-recovering: navigating to fresh chat...`);
        try {
          await this.sendRaw('Page.navigate', { url: 'https://chatgpt.com/' }, 5000);
          await abortableDelay(2000, signal);
          await this.dismissModals();
        } catch (e) {
          console.error(`[CDP:${this.role}] Auto-recovery navigation error:`, e.message);
        }
      }

      // Auto-recovery 3: If still not ready after 18s, force recycle tab
      if (elapsed > 18000 && !attemptedRecycle) {
        attemptedRecycle = true;
        console.warn(`[CDP:${this.role}] Composer still not ready after 18s. Force recycling tab...`);
        try {
          await this.forceRefreshTarget(signal);
          await this.ensureConnected(signal);
        } catch (e) {
          if (signal?.aborted) throw e;
          console.error(`[CDP:${this.role}] Auto-recovery recycle error:`, e.message);
        }
      }

      await abortableDelay(200, signal);
    }

    if (!composerReady) {
      throw new Error(`[CDP:${this.role}] ChatGPT composer (#prompt-textarea) not ready within 35 seconds`);
    }

    // 3. Inject text via native CDP Input.insertText (fires real beforeinput/input that ProseMirror handles).
//    Merged with composer-wait: after a new-chat cycle React can remount the composer, so retry the whole
//    focus+clear+insert+verify sequence until it lands (up to 20s). A short settle after focus avoids
//    wedging CDP's input pipeline if React is still reconciling the composer.
    let injected = false;
    let verified = false;
    let injectFailures = 0;
    let forcedFreshForStaleComposer = false;
    const injectDeadline = Date.now() + 60000;
    while (Date.now() < injectDeadline && !injected) {
      throwIfAborted();
      await this.dismissModals();
      // Re-assert window focus + focus emulation every attempt. A single setFocus at request start
      // is insufficient: if a prior Input command wedged the pipeline, re-asserting resets it
      // (matches the known-good probe sequence that always inserts in ~60ms).
      if (injectFailures > 0) {
        try { await this.sendRaw('Page.bringToFront', {}, 3000); } catch {}
        try { await this.sendRaw('Emulation.setFocusEmulationEnabled', { enabled: true }, 3000); } catch {}
      }
      try {
        const t0 = Date.now();
        const ready = await this.evaluate(`(() => {
          const ta = document.querySelector('#prompt-textarea, div[contenteditable="true"][tabindex="0"], div[contenteditable="true"]');
          if (!ta) return { ok: false, reason: 'selector-miss' };
          if (ta.offsetParent === null) return { ok: false, reason: 'hidden' };
          if (!ta.isContentEditable) return { ok: false, reason: 'not-editable', tag: ta.tagName };
          const r = ta.getBoundingClientRect();
          ta.focus();
          return {
            ok: true,
            editable: true,
            hasText: (ta.innerText || '').trim().length > 0,
            x: r.left + r.width / 2,
            y: r.top + r.height / 2
          };
        })()`, 3000);

        if (!ready?.ok) {
          if (injectFailures === 0 || injectFailures % 5 === 0) {
            console.warn(`[CDP:${this.role}] Composer probe not ready: ${JSON.stringify(ready)}`);
          }
        } else if (ready.editable) {
          if (ready.hasText && !forcedFreshForStaleComposer) {
            // ChatGPT can restore the previous draft into a new/home tab. Do not
            // navigate here: Page.navigate can wedge the renderer while the draft
            // is present. Clear it through the real keyboard path below first.
            forcedFreshForStaleComposer = true;
            console.warn('[CDP:' + this.role + '] Stale composer text detected. Clearing draft in-place before injection...');
          }
          if (ready.x && ready.y) {
            try {
              await this.sendRaw('Input.dispatchMouseEvent', { type: 'mousePressed', x: ready.x, y: ready.y, button: 'left', clickCount: 1 }, 2000);
              await this.sendRaw('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ready.x, y: ready.y, button: 'left', clickCount: 1 }, 2000);
            } catch {}
          }
          await abortableDelay(100, signal);
          if (ready.hasText) {
            // React/ProseMirror may restore draft state after direct DOM mutation.
            // Clear through the real keyboard path first, then verify the rendered
            // composer is empty before inserting the new prompt.
            try {
              await this.sendRaw('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 }, 2000);
              await this.sendRaw('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 }, 2000);
              await this.sendRaw('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 }, 2000);
              await this.sendRaw('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 }, 2000);
              await this.sendRaw('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, 2000);
              await this.sendRaw('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }, 2000);
            } catch {}
            await abortableDelay(150, signal);
            let cleared = await this.evaluate(`() => {
              const ta = document.querySelector('#prompt-textarea, div[contenteditable="true"]');
              if (!ta) return false;
              return (ta.innerText || ta.textContent || '').trim().length === 0;
            })()`, 3000).catch(() => false);
            if (!cleared) {
              // Last resort: controlled DOM clear, followed by another rendered-state check.
              cleared = await this.evaluate(`() => {
                const ta = document.querySelector('#prompt-textarea, div[contenteditable="true"]');
                if (!ta) return false;
                ta.focus();
                try {
                  const sel = window.getSelection();
                  const range = document.createRange();
                  range.selectNodeContents(ta);
                  sel.removeAllRanges();
                  sel.addRange(range);
                  document.execCommand('delete', false, null);
                } catch {}
                ta.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' }));
                return (ta.innerText || ta.textContent || '').trim().length === 0;
              })()`, 3000).catch(() => false);
            }
            if (!cleared) {
              // Some ChatGPT profiles restore a ProseMirror draft that ignores
              // the normal keyboard clear. Prefer replacing the selected DOM
              // range with native CDP Input.insertText before recycling; this
              // avoids an endless fresh-tab loop when the draft is persistent.
              try {
                await this.evaluate(`(() => {
                  const ta = document.querySelector('#prompt-textarea, div[contenteditable="true"]');
                  if (!ta) return false;
                  ta.focus();
                  const sel = window.getSelection();
                  const range = document.createRange();
                  range.selectNodeContents(ta);
                  sel.removeAllRanges();
                  sel.addRange(range);
                  return true;
                })()`, 2500);
                await this.sendRaw('Input.insertText', { text: prompt }, 3000);
                const replaced = await this.evaluate(`(() => {
                  const ta = document.querySelector('#prompt-textarea, div[contenteditable="true"]');
                  return ta ? (ta.innerText || ta.textContent || '').trim() : '';
                })()`, 2500).catch(() => '');
                const a = String(replaced).replace(/\s+/g, ' ');
                const b = prompt.replace(/\s+/g, ' ');
                if (a === b || (b.length > 150 && a.includes(b.slice(0, 80)))) {
                  injected = true;
                  console.log(`[CDP:${this.role}] Replaced persistent composer draft via native Input.insertText.`);
                }
              } catch (e) {
                console.warn(`[CDP:${this.role}] Persistent draft replacement failed: ${e.message}`);
              }
              if (!injected) {
                console.warn(`[CDP:${this.role}] Composer draft survived replacement; recycling tab.`);
                try {
                  await this.forceRefreshTarget(signal);
                  await this.ensureConnected(signal);
                } catch (e) {
                  if (signal?.aborted) throw e;
                  console.error(`[CDP:${this.role}] Composer recycle error:`, e.message);
                }
                await abortableDelay(250, signal);
              }
              continue;
            }
            await abortableDelay(250, signal);
          }
          try {
            await this.sendRaw('Input.insertText', { text: prompt }, 3000);
            await this.evaluate(`(() => {
              const ta = document.querySelector('#prompt-textarea');
              if (ta) {
                ta.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
              }
            })()`, 1500).catch(() => {});
            const observed = await this.evaluate(`(() => {
              const ta = document.querySelector('#prompt-textarea, div[contenteditable="true"]');
              return ta ? (ta.innerText || ta.textContent || '').trim() : '';
            })()`, 2000).catch(() => '');
            const normObserved = String(observed).replace(/\s+/g, ' ');
            const normPrompt = prompt.replace(/\s+/g, ' ');
            injected = normObserved === normPrompt || (normPrompt.length > 150 && normObserved.includes(normPrompt.slice(0, 80)));
            if (!injected) console.warn(`[CDP:${this.role}] Input.insertText returned but composer state did not update; retrying injection.`);
          } catch (err) {
            console.warn(`[CDP:${this.role}] Input.insertText failed (${Date.now() - t0}ms), falling back to execCommand:`, err.message);
            try {
              const fallbackOk = await this.evaluate(`(() => {
                const ta = document.querySelector('#prompt-textarea, div[contenteditable="true"]');
                if (!ta) return false;
                ta.focus();
                const p = ta.querySelector('p') || ta;
                p.textContent = ${JSON.stringify(prompt)};
                ta.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: ${JSON.stringify(prompt)} }));
                ta.dispatchEvent(new Event('change', { bubbles: true }));
                try {
                  document.execCommand('selectAll', false, null);
                  document.execCommand('insertText', false, ${JSON.stringify(prompt)});
                } catch {}
                return true;
              })()`, 4500);
              if (fallbackOk) {
                const observed = await this.evaluate(`(() => {
                  const ta = document.querySelector('#prompt-textarea, div[contenteditable="true"]');
                  return ta ? (ta.innerText || ta.textContent || '').trim() : '';
                })()`, 2000).catch(() => '');
                const normObserved = String(observed).replace(/\s+/g, ' ');
                const normPrompt = prompt.replace(/\s+/g, ' ');
                injected = normObserved === normPrompt || (normPrompt.length > 150 && normObserved.includes(normPrompt.slice(0, 80)));
              }
            } catch {}
            if (injected) await abortableDelay(200, signal);
          }
        }
      } catch (err) {
        console.warn(`[CDP:${this.role}] Inject attempt warning:`, err.message);
      }
      if (!injected) {
        injectFailures++;
        // Escalate fast: 2 consecutive failures usually mean the renderer input pipeline is
        // wedged (ProseMirror freeze on long-lived tabs). A hard reload clears it, then retry.
        if (injectFailures >= 2) {
          const reloaded = injectFailures;
          injectFailures = 0;
          console.warn(`[CDP:${this.role}] 2nd inject failure. Recycling tab to clear renderer/composer state (since failure #${reloaded})...`);
          try {
            await this.forceRefreshTarget(signal);
            await this.ensureConnected(signal);
          } catch (e) {
            if (signal?.aborted) throw e;
            console.error(`[CDP:${this.role}] Recovery recycle error:`, e.message);
          }
        }
        await abortableDelay(120, signal);
      }
    }

    if (!injected) {
      throw new Error(`[CDP:${this.role}] Could not inject prompt into composer`);
    }

    // 3b. Verify the composer actually contains the prompt (fast: usually <150ms)
    const injectStart = Date.now();
    while (Date.now() - injectStart < 3000) {
      throwIfAborted();
      try {
        const got = await this.evaluate(`(() => {
          const ta = document.querySelector('#prompt-textarea, div[contenteditable="true"]');
          return ta ? (ta.innerText || ta.textContent || '').trim() : '';
        })()`, 2500);
        const normA = got.replace(/\s+/g, ' ');
        const normB = prompt.replace(/\s+/g, ' ');
        if (normA === normB || (normB.length > 150 && normA.includes(normB.slice(0, 80)))) {
          verified = true;
          break;
        }
      } catch {}
      await abortableDelay(60, signal);
    }

    if (!verified) {
      throw new Error(`[CDP:${this.role}] Composer text not confirmed after injection`);
    }

    // 3c. Snapshot existing assistant messages before sending to detect new response
    let initialAssistantCount = 0;
    let initialLastText = '';
    try {
      const initSnap = await this.evaluate(`(() => {
        let msgs = Array.from(document.querySelectorAll('[data-message-author-role="assistant"], [data-turn="assistant"]'));
        if (msgs.length === 0) {
          const allTurns = Array.from(document.querySelectorAll('[data-testid*="conversation-turn"]'));
          const turns = allTurns.filter(t => (t.innerText || '').includes('ChatGPT đã nói') || t.querySelector('.agent-turn'));
          if (turns.length > 0) msgs = turns;
        }
        const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
        let lastText = last ? (last.innerText || last.textContent || '').trim() : '';
        if (!lastText && last) {
          lastText = (last.innerText || '').trim();
        }

        // Check if React composer is hard rate-limited
        let isRateBlocked = false;
        const btn = document.querySelector("#composer-submit-button, button[data-testid='send-button']");
        if (btn) {
          const fiberKey = Object.keys(btn).find(k => k.startsWith("__reactFiber"));
          let fiber = fiberKey ? btn[fiberKey] : null;
          while (fiber && !fiber.memoizedProps?.composerController) {
            fiber = fiber.return;
          }
          if (fiber?.memoizedProps?.disableReason === 'rate_limit_hard_block') {
            isRateBlocked = true;
          }
        }

        return {
          count: msgs.length,
          lastText: lastText,
          isRateBlocked
        };
      })()`, 2500);
      if (initSnap) {
        if (initSnap.isRateBlocked) {
          throw new Error(`[CDP:${this.role}] ChatGPT Rate Limit: Tài khoản đang bị giới hạn tạm thời (rate_limit_hard_block). Hệ thống tạm ngưng gửi yêu cầu để chờ mở khóa.`);
        }
        initialAssistantCount = initSnap.count || 0;
        initialLastText = initSnap.lastText || '';
      }
    } catch (snapErr) {
      if (snapErr.message.includes('rate_limit_hard_block')) throw snapErr;
    }

    // 4. Poll for Send button to become enabled and click it (up to 5s)
    const sendStart = Date.now();
    let clickedSend = false;
    while (Date.now() - sendStart < 5000) {
      throwIfAborted();
      try {
        const res = await this.evaluate(`(() => {
          const bottom = document.querySelector('#thread-bottom-container') || document;
          const btn = bottom.querySelector('button[data-testid="send-button"]')
            || document.querySelector('button[data-testid="send-button"]')
            || document.querySelector('button[data-testid="fruitjuice-send-button"]')
            || bottom.querySelector('button[aria-label*="Gửi"]')
            || bottom.querySelector('button[aria-label*="Send"]');
          if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true' && !btn.hasAttribute('data-visually-disabled')) {
            btn.click();
            return { ok: true };
          }
          return { ok: false };
        })()`, 2000);

        if (res && res.ok) {
          clickedSend = true;
          break;
        }
      } catch {}
      await abortableDelay(150, signal);
    }

    // Fallback: If Send button wasn't clicked in time, dispatch Enter key via CDP
    if (!clickedSend) {
      console.log(`[CDP:${this.role}] Send button not ready after 5s, dispatching Enter key fallback...`);
      try {
        await this.evaluate(`(() => {
          const ta = document.querySelector('#prompt-textarea, div[contenteditable="true"]');
          if (ta) ta.focus();
        })()`, 2000);
      } catch {}
      try {
        await this.sendRaw('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13
        }, 2000);
        await this.sendRaw('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13
        }, 2000);
      } catch {}
    }

    // 5. Poll for response at a fast cadence (120ms) so tokens + completion feel real-time
    const startTime = Date.now();
    let emittedLength = 0;
    let lastText = '';
    let lastChangedAt = startTime;
    let generationStarted = false;
    let consecutivePollErrors = 0;
    let genRecovered = 0;
    const POLL_INTERVAL = 120;

    while (Date.now() - startTime < timeoutMs) {
      throwIfAborted();
        await abortableDelay(POLL_INTERVAL, signal);
      throwIfAborted();

      const pollExpr = `(() => {
        const pageText = String(document.body?.innerText || '');
        const lowerPageText = pageText.toLowerCase();
        if (lowerPageText.includes('too many requests') || lowerPageText.includes('quá nhiều yêu cầu') || lowerPageText.includes('gửi yêu cầu quá nhanh')) {
          return { rateLimited: true };
        }

        const assistantMsgs = Array.from(document.querySelectorAll('[data-message-author-role="assistant"], [data-turn="assistant"]'));
        const assistantCount = assistantMsgs.length;
        const hasAssistant = assistantCount > 0;
        const lastMsg = hasAssistant ? assistantMsgs[assistantMsgs.length - 1] : null;
        const latestText = lastMsg ? String(lastMsg.innerText || lastMsg.textContent || '').trim() : '';
        const stopBtn = document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="Dừng"]');
        const sendBtn = document.querySelector('button[data-testid="send-button"], button[data-testid="fruitjuice-send-button"]');
        const isBusy = !!document.querySelector('.result-streaming, .result-thinking, [aria-busy="true"], [data-streaming-response-status]');
        const hasCopyBtn = !!document.querySelector('button[data-testid="copy-turn-action-button"]');
        const hasSpin = !!document.querySelector('.animate-spin, svg.animate-spin');
        const isGenerating = !!stopBtn || isBusy || hasSpin || (!sendBtn && !hasCopyBtn && hasAssistant && !latestText);
        const openaiError = lowerPageText.includes('something went wrong') && (lowerPageText.includes('thử lại') || lowerPageText.includes('try again'));
        return { hasAssistant, assistantCount, isGenerating, latestText, hasCopyBtn, hasSendBtn: !!sendBtn, hasStopBtn: !!stopBtn, openaiError };
      })()`;

      let status;
      try {
        status = await this.evaluate(pollExpr, 5000);
        consecutivePollErrors = 0;
      } catch (pollErr) {
        throwIfAborted();
        consecutivePollErrors++;
        console.warn(`[CDP:${this.role}] Poll evaluate warning (${consecutivePollErrors}):`, pollErr.message);
        if (consecutivePollErrors >= 6) {
          throw pollErr;
        }
        await abortableDelay(250, signal);
        continue;
      }

      if (!status) continue;

      // Sanitize internal CoS metadata noise from latestText
      if (status.latestText) {
        let clean = status.latestText;
        if (clean.includes('--- Identity notice ---')) {
          clean = clean.split('--- Identity notice ---')[0].trim();
        }
        if (clean.includes('supplemental_context:')) {
          clean = clean.split('supplemental_context:')[0].trim();
        }
        clean = clean.replaceAll('Đã nhận được phản hồi từ ứng dụng', '').trim();
        status.latestText = clean;
      }

      if (status.rateLimited) {
        throw new Error(`[CDP:${this.role}] ChatGPT Rate Limit: Hệ thống đang bị tạm giới hạn do gửi yêu cầu dồn dập. Vui lòng đợi 2-3 phút.`);
      }

      // OpenAI web error bubble ("Something went wrong. …Thử lại"): never return that
      // garbage as the reply. Cycle to a fresh chat and surface a clear error so the
      // caller (openclaw) does NOT deliver the error text to the Boss.
      if (status.openaiError) {
        console.warn(`[CDP:${this.role}] OpenAI web returned an error bubble. Cycling to a fresh chat.`);
        try {
          await this.navigateFreshChat(signal);
        } catch (e) {
          console.error(`[CDP:${this.role}] Error-recovery navigation failure:`, e.message);
        }
        throw new Error(`[CDP:${this.role}] OpenAI web error bubble (Something went wrong). Aborting to avoid delivering an error as the reply.`);
      }

      const isNewTurn = status.assistantCount > initialAssistantCount;
      const isTextChanged = (status.latestText !== initialLastText) && (status.latestText || '').length > 0;

      if (status.isGenerating || isNewTurn || (generationStarted && isTextChanged) || (status.assistantCount > 0 && status.latestText?.length > 0)) {
        generationStarted = true;
      }

      const currentText = status.latestText || '';

      // Emit chunk if streaming
      if (onChunk && currentText.length > emittedLength && (isNewTurn || isTextChanged)) {
        const delta = currentText.slice(emittedLength);
        emittedLength = currentText.length;
        lastChangedAt = Date.now();
        onChunk(delta);
      }

      if (currentText !== lastText) {
        lastChangedAt = Date.now();
      }
      lastText = currentText;

      const unchangedMs = Date.now() - lastChangedAt;

      // Phantom-generation detection: the tab has been stuck "generating" for a long time
      // with no new text and no completion (free-tier ChatGPT web sometimes enters a wedged
      // state where the stop button persists forever). Recover once by cycling to a fresh
      // regular chat; processQueue re-runs the whole prompt on the clean tab.
      if (genRecovered === 0 && unchangedMs > 45000 &&
          (status.isGenerating || (status.hasAssistant && !currentText) || (!status.hasAssistant && !currentText))) {
        genRecovered = 1;
        console.warn(`[CDP:${this.role}] Response stalled ${Math.round(unchangedMs / 1000)}s with no text progress. Hard-recovering to fresh chat...`);
        try {
          await this.navigateFreshChat(signal);
        } catch (e) {
          console.error(`[CDP:${this.role}] Stall-recovery navigation error:`, e.message);
        }
        throw new Error(`[CDP:${this.role}] STALL_RECOVERY`);
      }

      // Completion condition:
      // 1) NOT generating anymore, and copy/send button or stable text >= 700ms proves final render.
      // 2) OR copy button is present and text hasn't changed for >= 2000ms (even if isGenerating flag is wedged).
      // 3) OR text has been completely stable for >= 10000ms.
      const isNormalDone = !status.isGenerating && (isNewTurn || isTextChanged) && (status.hasCopyBtn || status.hasSendBtn || unchangedMs >= 700);
      const isWedgedDone = status.hasCopyBtn && unchangedMs >= 2000;
      const isTimeoutDone = unchangedMs >= 10000 && currentText.length > 0;

      if (generationStarted && currentText.length > 0 && (isNormalDone || isWedgedDone || isTimeoutDone)) {
        if (onChunk && currentText.length > emittedLength) {
          onChunk(currentText.slice(emittedLength));
        }
        console.log(`[CDP:${this.role}] Response completed (${currentText.length} chars, reason: ${isNormalDone ? 'normal' : (isWedgedDone ? 'copy-button-quiescence' : 'stable-timeout')})`);
        return currentText;
      } else if (!status.isGenerating && currentText.length > 0 && unchangedMs >= 3000) {
        // Fallback for tools / CoS: if text is present and not generating for 3s
        if (onChunk && currentText.length > emittedLength) {
          onChunk(currentText.slice(emittedLength));
        }
        console.log(`[CDP:${this.role}] Response completed via tool-quiescence fallback (${currentText.length} chars)`);
        return currentText;
      }
    }

    if (lastText.length > 0) {
      return lastText;
    }
    throw new Error(`[CDP:${this.role}] Timeout waiting for ChatGPT response (${timeoutMs}ms)`);
  }
}

export class ChatGPTBrowserBridge {
  constructor(options = {}) {
    this.cdpPort = options.cdpPort || 9021;
    this.cdpHost = options.cdpHost || '127.0.0.1';
    this.userDataDir = options.userDataDir || '/home/long/.config/google-chrome-chatgpt';
    this.accountName = options.accountName || `Account:${this.cdpPort}`;
    // Each tab is an execution lane. A lane is serialized internally, while
    // independent lanes may run concurrently across roles/accounts.
    this.singleTabMode = options.singleTabMode ?? (process.env.SINGLE_TAB_MODE === 'true');
    this.workers = new Map(); // role -> TabWorker
    this.masterWorker = null;
    this.prewarmRoles = ['coordinator', 'cto', 'reviewer'];
    this.browserStartPromise = null;
  }

  get cdpBaseUrl() {
    return `http://${this.cdpHost}:${this.cdpPort}`;
  }

  async isCdpAvailable(signal = null) {
    try {
      const probeSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(1500)])
        : AbortSignal.timeout(1500);
      const res = await fetch(`${this.cdpBaseUrl}/json/version`, { signal: probeSignal });
      return res.ok;
    } catch {
      if (signal?.aborted) throw new Error('Request aborted by caller');
      return false;
    }
  }

  async ensureVirtualDisplay(signal = null) {
    if (signal?.aborted) throw new Error('Request aborted by caller');
    const display = process.env.VIRTUAL_DISPLAY || ':99';
    try {
      const test = spawn('xdpyinfo', [], {
        env: { ...process.env, DISPLAY: display },
        stdio: 'ignore'
      });
      const ok = await awaitWithSignal(new Promise((resolve) => {
        test.on('exit', code => resolve(code === 0));
        test.on('error', () => resolve(false));
      }), signal);
      if (ok) return display;
    } catch {}

    console.log(`[CDP] Virtual display ${display} not active. Launching Xvfb...`);
    const xvfbBin = '/home/long/.local/bin/Xvfb';
    try {
      const xvfb = spawn(xvfbBin, [display, '-screen', '0', '1920x1080x24', '-ac', '+extension', 'GLX', '+render', '-noreset'], {
        detached: true,
        stdio: 'ignore'
      });
      xvfb.unref();
      await abortableDelay(1000, signal);
    } catch (e) {
      console.error('[CDP] Could not start Xvfb:', e.message);
    }
    return display;
  }

  async ensureBrowserRunning(signal = null) {
    if (signal?.aborted) throw new Error('Request aborted by caller');
    if (await this.isCdpAvailable(signal)) return;

    if (this.browserStartPromise) return awaitWithSignal(this.browserStartPromise, signal);

    const startup = this._startBrowser();
    this.browserStartPromise = startup;
    try {
      await awaitWithSignal(startup, signal);
    } finally {
      if (this.browserStartPromise === startup) {
        this.browserStartPromise = null;
      }
    }
  }

  async _startBrowser() {
    if (await this.isCdpAvailable()) return;

    const display = await this.ensureVirtualDisplay();

    console.log(`[CDP] Chrome CDP port ${this.cdpPort} is not running. Auto-launching Chrome on virtual display ${display}...`);
    const args = [
      '--ozone-platform=x11',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-gpu-compositing',
      `--remote-debugging-port=${this.cdpPort}`,
      `--user-data-dir=${this.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-sync',
      '--mute-audio',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--js-flags=--max-old-space-size=2048',
      '--window-size=1920,1080',
      '--window-position=0,0',
      'https://chatgpt.com'
    ];

    try {
      const procEnv = { ...process.env, DISPLAY: display };
      delete procEnv.WAYLAND_DISPLAY;
      const proc = spawn('google-chrome', args, {
        detached: true,
        stdio: 'ignore',
        env: procEnv
      });
      proc.unref();
    } catch (err) {
      console.error('[CDP] Failed to spawn Chrome process:', err.message);
      throw new Error(`Failed to auto-spawn Chrome: ${err.message}`);
    }

    const start = Date.now();
    while (Date.now() - start < 90000) {
      await abortableDelay(500);
        if (await this.isCdpAvailable()) {
          console.log(`[CDP] Chrome CDP is now online on port ${this.cdpPort}!`);
          // Port readiness can precede renderer readiness by several seconds.
          // Let Chrome finish renderer startup before TabWorker sends Runtime.enable.
          await abortableDelay(10_000);
          return;
        }
    }
    throw new Error(`Chrome was launched but CDP port ${this.cdpPort} did not become ready within 90 seconds.`);
  }

  async getTargets(signal = null) {
    await this.ensureBrowserRunning(signal);
    if (signal?.aborted) throw new Error('Request aborted by caller');
    const res = await fetch(`${this.cdpBaseUrl}/json/list`, { signal });
    if (!res.ok) throw new Error(`Failed to fetch targets: ${res.statusText}`);
    return await res.json();
  }

  async createNewTab(url = 'https://chatgpt.com', signal = null) {
    await this.ensureBrowserRunning(signal);
    console.log(`[CDP] Creating new tab for ${url}...`);
    const res = await fetch(`${this.cdpBaseUrl}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal });
    if (!res.ok) throw new Error(`Failed to create tab: ${res.statusText}`);
    return await res.json();
  }

  normalizeRole(role) {
    if (!role) return 'coordinator';
    const r = role.toLowerCase().trim();
    if (r === 'coordinator' || r.includes('staff') || r.includes('cos')) return 'coordinator';
    if (r === 'cto' || r.includes('cto')) return 'cto';
    if (r === 'architect' || r.includes('architect')) return 'architect';
    if (r === 'engineer' || r.includes('engineer') || r.includes('developer')) return 'engineer';
    if (r === 'platform' || r.includes('platform') || r.includes('devops')) return 'platform';
    if (r === 'reviewer' || r.includes('review')) return 'reviewer';
    if (r === 'qa' || r.includes('qa') || r.includes('quality')) return 'qa';
    if (r === 'security' || r.includes('security')) return 'security';
    if (r === 'researcher' || r.includes('research')) return 'researcher';
    if (r === 'product-owner' || r.includes('product')) return 'product-owner';
    if (r === 'writer' || r.includes('write')) return 'writer';
    return r;
  }

  async acquireTarget(role, signal = null) {
    const targets = await this.getTargets(signal);
    const chatGptPages = targets.filter(t => t.type === 'page' && (t.url?.includes('chatgpt.com') || t.url === 'about:blank'));

    // In Single-Tab Mode, all roles multiplex onto one single tab
    if (this.singleTabMode) {
      if (chatGptPages.length > 0) {
        const conversation = chatGptPages.find(t => /chatgpt\.com\/c\//.test(t.url || ''));
        const chosen = conversation || chatGptPages[0];
        console.log(`[CDP] [SingleTab] Multiplexing role '${role}' on ${conversation ? 'conversation' : 'primary'} tab ${chosen.id}.`);
        return chosen;
      }
      console.log(`[CDP] [SingleTab] No active ChatGPT tab found. Creating the single master tab...`);
      return await this.createNewTab('https://chatgpt.com', signal);
    }

    // Multi-Tab Mode:
    // 1. Check if a worker already has a target assigned
    const assignedTargetIds = new Set();
    for (const [r, w] of this.workers.entries()) {
      if (r !== role && w.targetId) {
        assignedTargetIds.add(w.targetId);
      }
    }

    // 2. Find an unassigned ChatGPT tab
    const unassigned = chatGptPages.find(t => !assignedTargetIds.has(t.id));
    if (unassigned) {
      console.log(`[CDP] Assigned existing unassigned tab ${unassigned.id} to role '${role}'.`);
      return unassigned;
    }

    // 3. No unassigned tab found -> Create a new tab!
    console.log(`[CDP] No unassigned tab found for role '${role}'. Creating a new tab in Chrome...`);
    const newTarget = await this.createNewTab('https://chatgpt.com', signal);
    console.log(`[CDP] Created new tab ${newTarget.id} for role '${role}'.`);
    return newTarget;
  }

  async getWorker(role = 'coordinator', signal = null) {
    if (signal?.aborted) throw new Error('Request aborted by caller');
    if (this.singleTabMode) {
      if (this.masterWorker) {
        return this.masterWorker;
      }
      console.log(`[CDP] [SingleTab] Initializing unified Master TabWorker...`);
      const target = await this.acquireTarget('master', signal);
      if (signal?.aborted) throw new Error('Request aborted by caller');
      this.masterWorker = new TabWorker('master', this, target);
      this.workers.set('master', this.masterWorker);

      this.masterWorker.ensureConnected().catch(err => {
        console.error(`[CDP] Background connect failed for Master TabWorker:`, err.message);
      });

      return this.masterWorker;
    }

    const normRole = this.normalizeRole(role);

    if (this.workers.has(normRole)) {
      const worker = this.workers.get(normRole);
      return worker;
    }

    console.log(`[CDP] Initializing dedicated TabWorker for role '${normRole}'...`);
    const target = await this.acquireTarget(normRole, signal);
    if (signal?.aborted) throw new Error('Request aborted by caller');
    const worker = new TabWorker(normRole, this, target);
    this.workers.set(normRole, worker);

    // Eagerly connect in background
    worker.ensureConnected().catch(err => {
      console.error(`[CDP] Background connect failed for role '${normRole}':`, err.message);
    });

    return worker;
  }

  async ask(prompt, onChunk = null, timeoutMs = 180000, role = 'coordinator', priority = null, signal = null) {
    if (priority === null) {
      const norm = this.normalizeRole(role);
      if (norm === 'coordinator' || norm.includes('boss')) {
        priority = 0; // P0: Boss / WhatsApp / Coordinator
      } else if (norm === 'cto' || norm.includes('architect') || norm.includes('review') || norm.includes('security')) {
        priority = 1; // P1: Architect / Decision / Review
      } else {
        priority = 2; // P2: Worker / Code / QA / Content
      }
    }
    if (signal?.aborted) throw new Error('Request aborted by caller');
    const worker = await this.getWorker(role, signal);
    if (signal?.aborted) throw new Error('Request aborted by caller');
    return await worker.ask(prompt, onChunk, timeoutMs, priority, role, signal);
  }

  async cleanupExtraTabs() {
    try {
      const targets = await this.getTargets();
      const chatGptPages = targets.filter(t => t.type === 'page' && (t.url?.includes('chatgpt.com') || t.url === 'about:blank'));
      const activeTargetIds = new Set();

      if (this.singleTabMode && this.masterWorker && this.masterWorker.targetId) {
        activeTargetIds.add(this.masterWorker.targetId);
      } else {
        for (const w of this.workers.values()) {
          if (w.targetId) activeTargetIds.add(w.targetId);
        }
      }

      if (this.singleTabMode && activeTargetIds.size === 0 && chatGptPages.length > 0) {
        activeTargetIds.add(chatGptPages[0].id);
      }

      for (const page of chatGptPages) {
        if (!activeTargetIds.has(page.id)) {
          console.log(`[CDP] [SingleTab] Closing redundant tab ${page.id} (${page.title || page.url})...`);
          await fetch(`${this.cdpBaseUrl}/json/close/${page.id}`);
        }
      }
    } catch (e) {
      console.warn('[CDP] Cleanup extra tabs error:', e.message);
    }
  }

  async prewarm(roles = this.prewarmRoles) {
    if (this.singleTabMode) {
      console.log(`[CDP] [SingleTab] Pre-warming unified Master TabWorker...`);
      try {
        const worker = await this.getWorker('master');
        await worker.ensureConnected();
        console.log(`[CDP] [SingleTab] Master worker ready (tab: ${worker.targetId})`);
        await this.cleanupExtraTabs();
      } catch (err) {
        console.error(`[CDP] Failed to pre-warm Single-Tab worker:`, err.message);
      }
      return;
    }

    console.log(`[CDP] Pre-warming Multi-Tab workers for roles: [${roles.join(', ')}]...`);
    const promises = roles.map(async (role) => {
      try {
        const worker = await this.getWorker(role);
        await worker.ensureConnected();
        console.log(`[CDP] Pre-warmed role '${role}' (tab: ${worker.targetId})`);
      } catch (err) {
        console.error(`[CDP] Failed to pre-warm role '${role}':`, err.message);
      }
    });
    await Promise.all(promises);
    await this.cleanupExtraTabs();
    console.log(`[CDP] Multi-Tab pre-warm complete! Active tabs: ${this.workers.size}`);
  }

  getStatus() {
    const status = {
      workersCount: this.workers.size,
      roles: {}
    };
    for (const [role, worker] of this.workers.entries()) {
      status.roles[role] = {
        targetId: worker.targetId,
        ready: worker.ready,
        connected: Boolean(worker.ws && worker.ws.readyState === WebSocket.OPEN),
        processing: worker.processing,
        queueLength: worker.queue.length,
        lastActive: worker.lastActive
      };
    }
    return status;
  }
}

export class MultiAccountChatGPTBridge {
  constructor(options = {}) {
    this.cdpHost = options.cdpHost || '127.0.0.1';
    this.cooldownMs = options.cooldownMs !== undefined ? options.cooldownMs : 10000; // 10s pacing cooldown
    this.rateLimitCooldownMs = options.rateLimitCooldownMs || (3 * 60 * 1000); // ChatGPT UI says 2-3m for burst throttles
    this.rateLimitMaxCooldownMs = options.rateLimitMaxCooldownMs || (20 * 60 * 1000);
    this.rateLimitJitterRatio = Math.min(0.25, Math.max(0, Number(options.rateLimitJitterRatio) || 0.10));
    // ChatGPT web applies account/session-level burst protection. Do not rely on
    // the per-role tab model for admission: CTO + Architect + QA can otherwise
    // all observe activeRequests=0 during the same async selection window.
    // One in-flight model request per account is the safe default; parallelism
    // comes from genuinely independent account profiles.
    this.maxConcurrentRequestsPerAccount = Math.max(1, Number(options.maxConcurrentRequestsPerAccount) || 1);
    this.singleTabMode = options.singleTabMode !== undefined ? options.singleTabMode : true;

    const defaultConfigs = [
      { id: 1, name: 'Account 1', port: 9021, dataDir: '/home/long/.config/google-chrome-chatgpt' },
      { id: 2, name: 'Account 2', port: 9022, dataDir: '/home/long/.config/google-chrome-chatgpt-2' },
      { id: 3, name: 'Account 3', port: 9023, dataDir: '/home/long/.config/google-chrome-chatgpt-3' },
      { id: 4, name: 'Account 4', port: 9024, dataDir: '/home/long/.config/google-chrome-chatgpt-4' }
    ];

    const accountConfigs = options.accounts || defaultConfigs;

    this.accounts = accountConfigs.map(cfg => ({
      id: cfg.id,
      name: cfg.name,
      port: cfg.port,
      dataDir: cfg.dataDir,
      bridge: new ChatGPTBrowserBridge({
        cdpPort: cfg.port,
        cdpHost: this.cdpHost,
        userDataDir: cfg.dataDir,
        accountName: cfg.name,
        singleTabMode: this.singleTabMode
      }),
      rateLimitedUntil: 0,
      lastCompletedAt: 0,
      activeRequests: 0,
      reservedRequests: 0,
      totalRequests: 0,
      failedAttempts: 0,
      rateLimitStreak: 0
    }));

    this.rrIndex = 0;
  }

  normalizeRole(role) {
    return this.accounts[0].bridge.normalizeRole(role);
  }

  async getTargets() {
    const allTargets = [];
    for (const acc of this.accounts) {
      if (await acc.bridge.isCdpAvailable()) {
        try {
          const targets = await acc.bridge.getTargets();
          allTargets.push(...targets.map(t => ({ ...t, accountId: acc.id, accountName: acc.name })));
        } catch {}
      }
    }
    return allTargets;
  }

  async isCdpAvailable() {
    for (const acc of this.accounts) {
      if (await acc.bridge.isCdpAvailable()) return true;
    }
    return false;
  }

  async prewarm(roles) {
    const prewarmAll = process.env.PREWARM_ALL_ACCOUNTS === 'true';
    await Promise.all(this.accounts.map(async acc => {
      if (!prewarmAll && !(await acc.bridge.isCdpAvailable())) return;
      console.log(`[AccountPool] Pre-warming ${acc.name} (Port ${acc.port})...`);
      try {
        await acc.bridge.prewarm(roles);
      } catch (e) {
        console.warn(`[AccountPool] Pre-warm failed for ${acc.name}:`, e.message);
      }
    }));
  }

  resetRateLimits() {
    for (const acc of this.accounts) {
      acc.rateLimitedUntil = 0;
      acc.lastCompletedAt = 0;
    }
    console.log('[AccountPool] All account rate limits and cooldowns have been manually reset.');
  }

  restoreRateLimits(providerStates = []) {
    const byAccount = new Map((providerStates || []).map(s => [String(s.provider_id), s]));
    for (const acc of this.accounts) {
      const state = byAccount.get(`chatgpt:account:${acc.id}`);
      const until = state?.cooldown_until ? Date.parse(state.cooldown_until) : 0;
      if (Number.isFinite(until) && until > Date.now()) {
        acc.rateLimitedUntil = Math.max(acc.rateLimitedUntil, until);
      }
    }
  }

  getStatus() {
    return {
      totalAccounts: this.accounts.length,
      cooldownMs: this.cooldownMs,
      rateLimitCooldownMs: this.rateLimitCooldownMs,
      accounts: this.accounts.map(acc => {
        const isRateLimited = Date.now() < acc.rateLimitedUntil;
        const cooldownRemainingMs = Math.max(0, this.cooldownMs - (Date.now() - acc.lastCompletedAt));
        return {
          id: acc.id,
          name: acc.name,
          port: acc.port,
          dataDir: acc.dataDir,
          isRateLimited,
          rateLimitRemainingMs: isRateLimited ? (acc.rateLimitedUntil - Date.now()) : 0,
          isCooledDown: cooldownRemainingMs === 0,
          cooldownRemainingMs,
          activeRequests: acc.activeRequests,
          reservedRequests: acc.reservedRequests,
          effectiveLoad: acc.activeRequests + acc.reservedRequests,
          totalRequests: acc.totalRequests,
          bridgeStatus: acc.bridge.getStatus()
        };
      })
    };
  }

  async getAvailableAccounts(role = null, signal = null) {
    if (signal?.aborted) throw new Error('Request aborted by caller');
    const probes = await Promise.all(this.accounts.map(async acc => {
      if (Date.now() < acc.rateLimitedUntil) return null;
      const isUp = await Promise.race([
        acc.bridge.isCdpAvailable(signal),
        abortableDelay(2000, signal).then(() => false)
      ]);
      if (isUp) {
        if (role) {
          const normalizedRole = acc.bridge.normalizeRole(role);
          const roleStatus = acc.bridge.getStatus()?.roles?.[normalizedRole];
          // A role worker may still be connecting during startup/recycle. CDP itself
          // is healthy, so keep the account eligible; getWorker()/ensureConnected()
          // will finish initialization instead of silently removing the lane and
          // routing into a known stale account.
          if (roleStatus && (!roleStatus.ready || !roleStatus.connected)) {
            return { acc, isRunning: true, admissionState: 'starting' };
          }
        }
        return { acc, isRunning: true, admissionState: 'healthy' };
      }
      // Keep the primary lane eligible even during a transient CDP probe miss;
      // ChatGPTBrowserBridge can reconnect/spawn its target. Treating it as
      // non-running here can exclude the healthy primary account whenever another
      // stale account happens to report CDP up.
      if (acc.id === 1) return { acc, isRunning: true, admissionState: 'starting' };
      return null;
    }));
    if (signal?.aborted) throw new Error('Request aborted by caller');
    return probes.filter(Boolean);
  }

  async pickAccount(priority = 2, role = null, signal = null) {
    const throwIfAborted = () => { if (signal?.aborted) throw new Error('Request aborted by caller'); };
    // Selection itself contains awaits (CDP probes). Reserve the chosen slot
    // before any further await so concurrent callers cannot select the same
    // account based on the same stale activeRequests value.
    for (;;) {
      throwIfAborted();
      const candidates = await this.getAvailableAccounts(role, signal);
      throwIfAborted();

      if (candidates.length === 0) {
        const rateLimited = this.accounts.filter(a => Date.now() < a.rateLimitedUntil);
        if (rateLimited.length > 0) {
          let minUntil = Infinity;
          let earliestAcc = null;
          for (const a of rateLimited) {
            if (a.rateLimitedUntil < minUntil) {
              minUntil = a.rateLimitedUntil;
              earliestAcc = a;
            }
          }
          const waitMinutes = Math.ceil((minUntil - Date.now()) / 60000);
          throw new Error(`⚠️ [ChatGPT Bridge] Toàn bộ ${rateLimited.length} tài khoản ChatGPT đang chạy đều bị Rate Limit (rate_limit_hard_block). Tài khoản sớm nhất (${earliestAcc.name}) sẽ phục hồi sau ~${waitMinutes} phút.`);
        }
        return this.accounts[0];
      }

      const now = Date.now();
      // Prefer already running accounts
      const runningCandidates = candidates.filter(c => c.isRunning);
      const pool = runningCandidates.length > 0 ? runningCandidates : candidates;
      const freePool = pool.filter(c => (c.acc.activeRequests + c.acc.reservedRequests) < this.maxConcurrentRequestsPerAccount);

      // No account has a free model slot. Backpressure instead of launching a
      // concurrent request that can trigger ChatGPT's burst protection.
      if (freePool.length === 0) {
        await abortableDelay(250, signal);
        continue;
      }

      // Control-plane lanes stay on the primary account. Waiting for its
      // normal pacing cooldown is safer than switching browser profile and
      // inheriting a different ChatGPT composer/conversation state.
      if (this.normalizeRole(role) === 'coordinator' || this.normalizeRole(role) === 'cto') {
        const primary = freePool.find(c => c.acc.id === 1);
        if (primary) {
          primary.acc.reservedRequests++;
          const remainingWaitMs = Math.max(0, this.cooldownMs - (now - primary.acc.lastCompletedAt));
          try {
            if (remainingWaitMs > 0) {
              console.log(`[AccountPool] Control-plane pacing: waiting ${remainingWaitMs}ms on Account 1 for role '${role}'.`);
              await abortableDelay(remainingWaitMs, signal);
            }
            return primary.acc;
          } catch (err) {
            primary.acc.reservedRequests = Math.max(0, primary.acc.reservedRequests - 1);
            throw err;
          }
        }
        // If the primary account is absent from the candidate pool because it
        // is rate-limited/unavailable, fail over to a genuinely healthy account.
        // If it is present but busy, freePool would be empty and the backpressure
        // branch above waits instead of creating concurrent control-plane work.
        if (!pool.some(c => c.acc.id === 1)) {
          freePool[0].acc.reservedRequests++;
          return freePool[0].acc;
        }
        await abortableDelay(250, signal);
        continue;
      }

      // Check cooled down accounts in pool
      const cooledDown = freePool.filter(c => (now - c.acc.lastCompletedAt >= this.cooldownMs));

      if (cooledDown.length > 0) {
        cooledDown.sort((a, b) => {
          const stateA = a.admissionState === 'healthy' ? 0 : 1;
          const stateB = b.admissionState === 'healthy' ? 0 : 1;
          if (stateA !== stateB) return stateA - stateB;
          const loadA = a.acc.activeRequests + a.acc.reservedRequests;
          const loadB = b.acc.activeRequests + b.acc.reservedRequests;
          if (loadA !== loadB) return loadA - loadB;
          return a.acc.lastCompletedAt - b.acc.lastCompletedAt;
        });
        cooledDown[0].acc.reservedRequests++;
        return cooledDown[0].acc;
      }

      // All free slots are inside the normal pacing cooldown. Reserve the
      // earliest one and wait; reservation prevents another caller from
      // selecting it during this wait.
      freePool.sort((a, b) => {
        const remA = Math.max(0, this.cooldownMs - (now - a.acc.lastCompletedAt));
        const remB = Math.max(0, this.cooldownMs - (now - b.acc.lastCompletedAt));
        return remA - remB;
      });

      const chosen = freePool[0].acc;
      chosen.reservedRequests++;
      const remainingWaitMs = Math.max(0, this.cooldownMs - (now - chosen.lastCompletedAt));
      try {
        if (remainingWaitMs > 0) {
          console.log(`[AccountPool] ⏳ Pacing Cooldown: Đang chờ ${remainingWaitMs}ms trên ${chosen.name} để chống burst rate limit...`);
          await abortableDelay(remainingWaitMs, signal);
        }
        return chosen;
      } catch (err) {
        chosen.reservedRequests = Math.max(0, chosen.reservedRequests - 1);
        throw err;
      }
    }
  }

  async ask(prompt, onChunk = null, timeoutMs = 180000, role = 'coordinator', priority = null, signal = null) {
    const maxRetries = Math.max(2, this.accounts.length);
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => deadlineController.abort(), Math.max(1, timeoutMs));
    const effectiveSignal = signal
      ? AbortSignal.any([signal, deadlineController.signal])
      : deadlineController.signal;
    let lastError = null;

    try {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
      let chosenAcc;
      try {
        chosenAcc = await this.pickAccount(priority, role, effectiveSignal);
      } catch (err) {
        if (deadlineController.signal.aborted && !signal?.aborted) {
          throw new Error(`Timeout waiting for ChatGPT response after ${timeoutMs}ms`);
        }
        throw err;
      }

      console.log(`[AccountPool] Routing request for role '${role}' to ${chosenAcc.name} (Port ${chosenAcc.port}, Active: ${chosenAcc.activeRequests}, Attempt: ${attempt + 1}/${maxRetries})...`);
      chosenAcc.reservedRequests = Math.max(0, chosenAcc.reservedRequests - 1);
      chosenAcc.activeRequests++;
      chosenAcc.totalRequests++;

      try {
        if (signal?.aborted) throw new Error('Request aborted by caller');
        if (deadlineController.signal.aborted) throw new Error(`Timeout waiting for ChatGPT response after ${timeoutMs}ms`);
        const result = await chosenAcc.bridge.ask(prompt, onChunk, timeoutMs, role, priority, effectiveSignal);
        chosenAcc.lastCompletedAt = Date.now();
        chosenAcc.failedAttempts = 0;
        chosenAcc.rateLimitStreak = 0;
        return result;
      } catch (err) {
        lastError = err;
        if (signal?.aborted) {
          // An aborted request must still advance pacing/LRU state. Otherwise
          // a specialist retry sees Account 1 as the oldest/free lane and keeps
          // selecting the same account after every client disconnect.
          chosenAcc.lastCompletedAt = Date.now();
          chosenAcc.failedAttempts++;
          throw new Error('Request aborted by caller');
        }
        if (deadlineController.signal.aborted) {
          chosenAcc.lastCompletedAt = Date.now();
          chosenAcc.failedAttempts++;
          throw new Error(`Timeout waiting for ChatGPT response after ${timeoutMs}ms`);
        }
        if (err.message === 'Request aborted by caller') {
          // Preserve the original provider/bridge abort only when neither the
          // caller nor this bridge's deadline caused it. This keeps the HTTP
          // timeout contract distinct from an actual client disconnect.
          chosenAcc.lastCompletedAt = Date.now();
          chosenAcc.failedAttempts++;
          throw err;
        }
        err.accountId = chosenAcc.id;
        err.accountName = chosenAcc.name;
        const errMsg = err.message || '';
        const isRateLimit = /^\[CDP:[^\]]+\] ChatGPT Rate Limit(?:[: ]|$)/.test(errMsg.trim()) ||
          /rate_limit_hard_block/i.test(errMsg.trim()) && !/^Evaluation exception:/i.test(errMsg.trim());
        const isTransient = /Timeout waiting for ChatGPT response|STALL_RECOVERY|OpenAI web error bubble|CDP command .* timed out|WebSocket not connected|Composer text not confirmed after injection|Could not inject prompt into composer|fetch failed/i.test(errMsg)
          || err?.name === 'ErrorEvent'
          || err?.constructor?.name === 'ErrorEvent';

        // `timeoutMs` is the request's provider deadline. Do not turn an
        // already-expired provider attempt into an unbounded account failover
        // loop; the caller must receive the timeout contract promptly.
        if (/Timeout waiting for ChatGPT response/i.test(errMsg)) {
          chosenAcc.lastCompletedAt = Date.now();
          chosenAcc.failedAttempts++;
          throw err;
        }

        if (isRateLimit) {
          chosenAcc.rateLimitStreak = Math.min(8, (chosenAcc.rateLimitStreak || 0) + 1);
          const text = String(errMsg);
          const minuteMatches = [...text.matchAll(/(\d+)\s*(?:-|–|to)\s*(\d+)\s*(?:phút|minutes?|mins?)/ig)];
          const singleMinuteMatches = [...text.matchAll(/(\d+)\s*(?:phút|minutes?|mins?)/ig)];
          const observedWaitMs = minuteMatches.length
            ? Math.max(...minuteMatches.map(m => Number(m[2]) * 60_000))
            : singleMinuteMatches.length
              ? Math.max(...singleMinuteMatches.map(m => Number(m[1]) * 60_000))
              : 0;
          const exponentialMs = Math.min(
            this.rateLimitMaxCooldownMs,
            Math.max(this.rateLimitCooldownMs, this.rateLimitCooldownMs * (2 ** (chosenAcc.rateLimitStreak - 1)))
          );
          const baseMs = Math.max(observedWaitMs, exponentialMs);
          const jitterMs = Math.round(baseMs * this.rateLimitJitterRatio * Math.random());
          const cooldownMs = Math.min(this.rateLimitMaxCooldownMs, baseMs + jitterMs);
          chosenAcc.rateLimitedUntil = Date.now() + cooldownMs;
          console.warn(`[AccountPool] ⚠️ ${chosenAcc.name} (Port ${chosenAcc.port}) bị Rate Limit! streak=${chosenAcc.rateLimitStreak}, cooldown=${Math.ceil(cooldownMs / 1000)}s. Không retry nóng.`);

          // Check if ALL accounts in pool are now rate limited
          const allLimited = this.accounts.every(a => Date.now() < a.rateLimitedUntil);
          if (allLimited) {
            let minUntil = Infinity;
            let earliestAcc = null;
            for (const a of this.accounts) {
              if (a.rateLimitedUntil < minUntil) {
                minUntil = a.rateLimitedUntil;
                earliestAcc = a;
              }
            }
            const waitMinutes = Math.ceil((minUntil - Date.now()) / 60000);
            throw new Error(`⚠️ [ChatGPT Bridge] Toàn bộ ${this.accounts.length} tài khoản ChatGPT đang chạy đều bị Rate Limit (rate_limit_hard_block). Tài khoản sớm nhất (${earliestAcc?.name || 'Account 1'}) sẽ phục hồi sau ~${waitMinutes} phút.`);
          }

          continue;
        }

        if (isTransient && attempt < maxRetries - 1) {
          // Do not immediately select the same healthy-but-stalled account again.
          // Its lastCompletedAt is otherwise still zero, so LRU selection would
          // repeatedly route the next attempt back to the same broken lane.
          chosenAcc.lastCompletedAt = Date.now();
          chosenAcc.failedAttempts++;
          console.warn(`[AccountPool] Transient ChatGPT/CDP failure on ${chosenAcc.name}; retrying another account (${attempt + 2}/${maxRetries}).`);
          continue;
        }

        console.error(`[AccountPool] Error on ${chosenAcc.name}:`, errMsg);
        throw err;
      } finally {
        chosenAcc.activeRequests = Math.max(0, chosenAcc.activeRequests - 1);
      }
      }

      throw lastError || new Error(`[AccountPool] Failed to execute request across all available accounts.`);
    } finally {
      clearTimeout(deadlineTimer);
    }
  }
}
