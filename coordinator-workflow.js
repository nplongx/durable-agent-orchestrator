// coordinator-workflow.js
// Enterprise Finite State Machine (FSM) & Strategy Engine for Multi-Agent Coordination
// Replaces fragile if/else hardcoding with a robust, context-aware state machine.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';

export const States = Object.freeze({
  IDLE: 'IDLE',
  PROPOSED: 'PROPOSED',
  DISCUSSING: 'DISCUSSING',
  APPROVED: 'APPROVED',
  EXECUTING: 'EXECUTING',
  COMPLETED: 'COMPLETED'
});

export const Intents = Object.freeze({
  NEW_REQUEST: 'NEW_REQUEST',
  APPROVAL: 'APPROVAL',
  EXECUTION_CONTINUE: 'EXECUTION_CONTINUE',
  DISCUSSION: 'DISCUSSION',
  SUBAGENT_COMPLETION: 'SUBAGENT_COMPLETION',
  SUBAGENT_FAILURE: 'SUBAGENT_FAILURE',
  TOOL_RESULT: 'TOOL_RESULT',
  UNKNOWN: 'UNKNOWN'
});

export const Actions = Object.freeze({
  GENERATE_PROPOSAL: 'GENERATE_PROPOSAL',
  REFINE_PROPOSAL: 'REFINE_PROPOSAL',
  DISPATCH_TASK: 'DISPATCH_TASK',
  REPORT_EXECUTIVE_SUMMARY: 'REPORT_EXECUTIVE_SUMMARY',
  REPORT_FAILURE: 'REPORT_FAILURE',
  IN_PROGRESS_STATUS: 'IN_PROGRESS_STATUS',
  SILENT_ACK: 'SILENT_ACK',
  NO_OP: 'NO_OP'
});

// Helper to extract plain text from diverse message content formats
function extractTextFromTurn(turn) {
  if (!turn) return '';
  if (typeof turn.content === 'string') return turn.content;
  if (Array.isArray(turn.content)) {
    return turn.content.map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return JSON.stringify(part || '');
    }).join(' ');
  }
  return JSON.stringify(turn.content || '');
}

// Semantic Matching Strategies (Pattern Strategy Pattern)
class SubagentEventStrategy {
  intent = Intents.SUBAGENT_COMPLETION;

  matches(messages, currentTurn, state) {
    const raw = extractTextFromTurn(currentTurn);
    if (
      raw.includes('[Internal task completion event]') ||
      raw.includes('Child results awaiting delivery') ||
      raw.includes('Child completion results') ||
      raw.includes('A background task completed') ||
      raw.includes('Every subagent spawned from this session has now settled')
    ) {
      return true;
    }
    return false;
  }
}

class ToolResultStrategy {
  intent = Intents.TOOL_RESULT;

  matches(messages, currentTurn, state) {
    if (!currentTurn) return false;
    if (currentTurn.role === 'tool' || currentTurn.role === 'toolResult') {
      return true;
    }
    const text = extractTextFromTurn(currentTurn);
    if (
      text.includes('Validation failed for tool') ||
      text.includes('Tool result:') ||
      text.startsWith('{"toolCallId":')
    ) {
      return true;
    }
    return false;
  }
}

class ApprovalStrategy {
  intent = Intents.APPROVAL;
  
  // Exact semantic approval tokens
  static APPROVAL_REGEX = /^(ok|duyệt|đồng ý|triển khai đi|tiến hành đi|chốt|chốt phương án|duyệt kế hoạch|duyệt phương án|cho làm đi|triển khai ngay|tiến hành ngay|ok em|ok triển khai|làm đi|làm luôn|cho triển khai)(?:[.,!\s].*)?$/i;

  matches(messages, currentTurn, state) {
    if (!currentTurn || currentTurn.role !== 'user') return false;
    // Approvals are ONLY applicable if we are in PROPOSED or DISCUSSING state
    if (state !== States.PROPOSED && state !== States.DISCUSSING) {
      return false;
    }
    const text = extractTextFromTurn(currentTurn).trim();
    if (!text) return false;
    // Strip timestamp prefix if present: [Thu 2026-09-24 13:40 GMT+7] Duyệt
    const cleanedText = text.replace(/^\[[^\]]+\]\s*/, '').trim();
    if (ApprovalStrategy.APPROVAL_REGEX.test(cleanedText)) return true;
    // OpenClaw can preserve a queued prior turn before the current approval.
    // An explicit "Duyệt Job job_..." is unambiguous and must still reach
    // approval even when the current user turn contains that preserved prefix.
    return /(?:^|\n)\s*(?:duyệt|approve)\s+job\s+job_[0-9a-f-]{20,}\s*$/i.test(cleanedText);
  }
}

class DiscussionStrategy {
  intent = Intents.DISCUSSION;

  matches(messages, currentTurn, state) {
    if (!currentTurn || currentTurn.role !== 'user') return false;
    if (state !== States.PROPOSED && state !== States.DISCUSSING && state !== States.EXECUTING) {
      return false;
    }
    const text = extractTextFromTurn(currentTurn).trim();
    if (!text) return false;
    const cleanedText = text.replace(/^\[[^\]]+\]\s*/, '').trim();
    // Questions or adjustments
    return cleanedText.includes('?') || 
           cleanedText.startsWith('sao lại') || 
           cleanedText.startsWith('tại sao') || 
           cleanedText.startsWith('điều chỉnh') || 
           cleanedText.startsWith('sửa lại') ||
           cleanedText.startsWith('thay đổi') ||
           cleanedText.startsWith('thảo luận');
  }
}

class ExecutionContinueStrategy {
  intent = Intents.EXECUTION_CONTINUE;

  matches(messages, currentTurn, state) {
    if (!currentTurn || currentTurn.role !== 'user' || state !== States.EXECUTING) return false;
    const text = extractTextFromTurn(currentTurn).trim().replace(/^\[[^\]]+\]\s*/, '').toLowerCase();
    return /\b(?:continue|resume)\s+execution\b|\bexecution\s+now\b|tiếp tục execution|bắt đầu execution|tiếp tục triển khai|tiếp tục thực thi/.test(text);
  }
}

class SilentBackgroundStrategy {
  intent = Intents.TOOL_RESULT;

  matches(messages, currentTurn, state) {
    if (!currentTurn) return false;
    const text = extractTextFromTurn(currentTurn);
    return (
      text.includes('Skill review') ||
      text.includes('Distill new durable learning') ||
      text.includes('Continue the current task from the existing transcript') ||
      text.includes('Follow the heartbeat monitor') ||
      text.includes('[OpenClaw heartbeat poll]') ||
      text.includes('Skill Workshop')
    );
  }
}

class NewRequestStrategy {
  intent = Intents.NEW_REQUEST;

  matches(messages, currentTurn, state) {
    if (!currentTurn || currentTurn.role !== 'user') return false;
    const text = extractTextFromTurn(currentTurn).trim();
    if (!text) return false;
    // Filter OpenClaw internal markers, completions, and tool results
    if (
      text.includes('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>') || 
      text.includes('[Subagent Context]') ||
      text.includes('Active exec sessions:') ||
      text.includes('## Active Subagents') ||
      text.includes('[Internal task completion') ||
      text.includes('Child results awaiting delivery') ||
      text.includes('Child completion results') ||
      text.includes('A background task completed') ||
      text.includes('Every subagent spawned') ||
      text.includes('Validation failed for tool') ||
      text.includes('Validation failed') ||
      text.includes('Skill review') ||
      text.includes('Distill new durable learning') ||
      text.includes('Continue the current task') ||
      text.includes('Skill Workshop') ||
      text.includes('Follow the heartbeat monitor')
    ) {
      return false;
    }
    return true;
  }
}

export class IntentClassifier {
  static STRATEGIES = [
    new SilentBackgroundStrategy(),
    new SubagentEventStrategy(),
    new ToolResultStrategy(),
    new ApprovalStrategy(),
    new ExecutionContinueStrategy(),
    new DiscussionStrategy(),
    new NewRequestStrategy()
  ];

  static classify(messages, currentTurn, state) {
    for (const strategy of this.STRATEGIES) {
      if (strategy.matches(messages, currentTurn, state)) {
        return strategy.intent;
      }
    }
    return Intents.UNKNOWN;
  }
}

export const TRANSITION_TABLE = {
  [States.IDLE]: {
    [Intents.NEW_REQUEST]: {
      nextState: States.PROPOSED,
      action: Actions.GENERATE_PROPOSAL
    },
    [Intents.APPROVAL]: {
      nextState: States.PROPOSED,
      action: Actions.GENERATE_PROPOSAL
    },
    [Intents.SUBAGENT_COMPLETION]: {
      nextState: States.IDLE,
      action: Actions.REPORT_EXECUTIVE_SUMMARY
    },
    [Intents.SUBAGENT_FAILURE]: {
      nextState: States.IDLE,
      action: Actions.REPORT_FAILURE
    },
    [Intents.TOOL_RESULT]: {
      nextState: States.IDLE,
      action: Actions.SILENT_ACK
    }
  },
  [States.PROPOSED]: {
    [Intents.APPROVAL]: {
      nextState: States.EXECUTING,
      action: Actions.DISPATCH_TASK
    },
    [Intents.DISCUSSION]: {
      nextState: States.DISCUSSING,
      action: Actions.REFINE_PROPOSAL
    },
    [Intents.NEW_REQUEST]: {
      nextState: States.PROPOSED,
      action: Actions.GENERATE_PROPOSAL
    },
    [Intents.SUBAGENT_COMPLETION]: {
      nextState: States.IDLE,
      action: Actions.REPORT_EXECUTIVE_SUMMARY
    },
    [Intents.TOOL_RESULT]: {
      nextState: States.PROPOSED,
      action: Actions.SILENT_ACK
    }
  },
  [States.DISCUSSING]: {
    [Intents.APPROVAL]: {
      nextState: States.EXECUTING,
      action: Actions.DISPATCH_TASK
    },
    [Intents.DISCUSSION]: {
      nextState: States.DISCUSSING,
      action: Actions.REFINE_PROPOSAL
    },
    [Intents.NEW_REQUEST]: {
      nextState: States.PROPOSED,
      action: Actions.GENERATE_PROPOSAL
    },
    [Intents.SUBAGENT_COMPLETION]: {
      nextState: States.IDLE,
      action: Actions.REPORT_EXECUTIVE_SUMMARY
    },
    [Intents.TOOL_RESULT]: {
      nextState: States.DISCUSSING,
      action: Actions.SILENT_ACK
    }
  },
  [States.EXECUTING]: {
    [Intents.SUBAGENT_COMPLETION]: {
      nextState: States.IDLE,
      action: Actions.REPORT_EXECUTIVE_SUMMARY
    },
    [Intents.SUBAGENT_FAILURE]: {
      nextState: States.IDLE,
      action: Actions.REPORT_FAILURE
    },
    [Intents.DISCUSSION]: {
      nextState: States.EXECUTING,
      action: Actions.IN_PROGRESS_STATUS
    },
    [Intents.EXECUTION_CONTINUE]: {
      nextState: States.EXECUTING,
      action: Actions.DISPATCH_TASK
    },
    [Intents.NEW_REQUEST]: {
      // If a new request arrives while executing, acknowledge it
      nextState: States.PROPOSED,
      action: Actions.GENERATE_PROPOSAL
    },
    [Intents.TOOL_RESULT]: {
      nextState: States.EXECUTING,
      action: Actions.SILENT_ACK
    }
  }
};

let lastExecutiveSummaryTime = 0;

// Anti-Spam / Idempotency Cache
const sentMessageHashes = new Map();

function isDuplicateBroadcast(channel, message, ttlMs = 120000) {
  if (!message) return true;
  const normalized = message.trim().replace(/\s+/g, ' ');
  const hash = `${channel}:${crypto.createHash('sha256').update(normalized).digest('hex')}`;
  const now = Date.now();
  const lastSent = sentMessageHashes.get(hash);
  if (lastSent && (now - lastSent) < ttlMs) {
    console.log(`[FSM:AntiSpam] Duplicate message for channel ${channel} suppressed (hash: ${hash.slice(0, 16)}).`);
    return true;
  }
  sentMessageHashes.set(hash, now);
  if (sentMessageHashes.size > 200) {
    for (const [k, v] of sentMessageHashes.entries()) {
      if (now - v > ttlMs) sentMessageHashes.delete(k);
    }
  }
  return false;
}

export class CoordinatorSessionStateMachine {
  constructor(sessionId = 'default') {
    this.sessionId = sessionId;
    this.state = States.IDLE;
    this.activeTask = null;
    this.activeProposal = null;
    this.dispatchCount = 0;
    this.history = [];
  }

  // Derive conversation state from historical messages
  deriveStateFromMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      this.state = States.IDLE;
      return this.state;
    }

    let calculatedState = States.IDLE;
    let lastProposal = null;
    let currentTask = null;
    let hasDispatched = false;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'user') {
        const raw = extractTextFromTurn(msg);
        if (
          raw.includes('[Internal task completion event]') ||
          raw.includes('Child results awaiting delivery') ||
          raw.includes('Child completion results') ||
          raw.includes('A background task completed') ||
          raw.includes('Every subagent spawned from this session has now settled')
        ) {
          calculatedState = States.IDLE;
          hasDispatched = false;
          continue;
        }
        if (raw.includes('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>') || raw.includes('[Subagent Context]')) {
          continue;
        }

        const intent = IntentClassifier.classify(messages, msg, calculatedState);
        const transition = TRANSITION_TABLE[calculatedState]?.[intent];
        if (transition) {
          calculatedState = transition.nextState;
          if (transition.action === Actions.GENERATE_PROPOSAL) {
            currentTask = raw.replace(/^\[[^\]]+\]\s*/, '').trim();
            hasDispatched = false;
          } else if (transition.action === Actions.DISPATCH_TASK) {
            hasDispatched = true;
          }
        }
      } else if (msg.role === 'assistant') {
        const text = typeof msg.content === 'string' ? msg.content : '';
        if (text.includes('kế hoạch') || text.includes('đề xuất') || text.includes('phương án')) {
          lastProposal = text;
        }
        if (msg.tool_calls?.some(tc => (tc.function?.name || tc.name) === 'sessions_spawn')) {
          hasDispatched = true;
          calculatedState = States.EXECUTING;
        }
      }
    }

    if (!currentTask) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === 'user') {
          const raw = extractTextFromTurn(msg);
          const clean = raw.replace(/^\[[^\]]+\]\s*/, '').trim();
          if (
            clean &&
            !raw.includes('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>') &&
            !raw.includes('[Subagent Context]') &&
            !raw.includes('[Internal task completion') &&
            !ApprovalStrategy.APPROVAL_REGEX.test(clean)
          ) {
            currentTask = clean;
            break;
          }
        }
      }
    }

    this.state = calculatedState;
    this.activeTask = currentTask;
    this.activeProposal = lastProposal;
    return this.state;
  }

  processTurn(messages, tools = [], persistedContext = null) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return { previousState: States.IDLE, currentState: States.IDLE, intent: Intents.UNKNOWN, action: Actions.NO_OP };
    }

    // Identify last assistant index
    let lastAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        lastAssistantIdx = i;
        break;
      }
    }

    // Pending turns are ONLY messages occurring AFTER the last assistant response
    const pendingTurns = lastAssistantIdx !== -1 
      ? messages.slice(lastAssistantIdx + 1) 
      : messages;

    // Check what is pending
    let activeCompletionTurn = null;
    let activeUserTurn = null;
    let activeToolTurn = null;
    let isSilentBackground = false;

    for (let i = pendingTurns.length - 1; i >= 0; i--) {
      const turn = pendingTurns[i];
      const raw = extractTextFromTurn(turn);
      if (
        raw.includes('Skill review') ||
        raw.includes('Distill new durable learning') ||
        raw.includes('Continue the current task from the existing transcript') ||
        raw.includes('Follow the heartbeat monitor') ||
        raw.includes('[OpenClaw heartbeat poll]') ||
        raw.includes('Skill Workshop')
      ) {
        isSilentBackground = true;
        break;
      }

      const isCompletion = raw.includes('[Internal task completion event]') ||
        raw.includes('A background task completed') ||
        raw.includes('Child result') ||
        raw.includes('Child completion') ||
        raw.includes('Every subagent spawned');

      if (turn.role === 'tool' || turn.role === 'toolResult') {
        if (!activeToolTurn) activeToolTurn = turn;
      } else if (turn.role === 'user') {
        if (isCompletion) {
          if (!activeCompletionTurn) activeCompletionTurn = turn;
        } else if (!raw.includes('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>') && !raw.includes('[Subagent Context]')) {
          if (!activeUserTurn) activeUserTurn = turn;
        }
      }
    }

    // Phase 2: when durable business state is supplied, it is authoritative.
    // Transcript parsing remains an intent detector only; it is no longer the state store.
    if (persistedContext?.state) {
      this.state = persistedContext.state;
      this.activeTask = persistedContext.activeTask || this.activeTask;
      this.activeProposal = persistedContext.activeProposal || this.activeProposal;
    } else {
      const historicalMessages = lastAssistantIdx !== -1 ? messages.slice(0, lastAssistantIdx + 1) : [];
      this.deriveStateFromMessages(historicalMessages);
    }

    // If this is an OpenClaw internal background trigger -> SILENT_ACK
    if (isSilentBackground) {
      return {
        previousState: this.state,
        currentState: this.state,
        intent: Intents.TOOL_RESULT,
        action: Actions.SILENT_ACK,
        activeTask: this.activeTask,
        activeProposal: this.activeProposal
      };
    }

    // If an active subagent completion event occurred AFTER last assistant turn:
    if (activeCompletionTurn) {
      const prev = this.state;
      this.state = States.IDLE;
      return {
        previousState: prev,
        currentState: States.IDLE,
        intent: Intents.SUBAGENT_COMPLETION,
        action: Actions.REPORT_EXECUTIVE_SUMMARY,
        activeTask: this.activeTask,
        activeProposal: this.activeProposal
      };
    }

    // If an active user turn occurred AFTER last assistant turn:
    if (activeUserTurn) {
      const intent = IntentClassifier.classify(messages, activeUserTurn, this.state);
      const transition = TRANSITION_TABLE[this.state]?.[intent] || {
        nextState: States.PROPOSED,
        action: Actions.GENERATE_PROPOSAL
      };
      const previousState = this.state;
      this.state = transition.nextState;
      if (transition.action === Actions.GENERATE_PROPOSAL) {
        this.activeTask = extractTextFromTurn(activeUserTurn).replace(/^\[[^\]]+\]\s*/, '').trim();
      }
      return {
        previousState,
        currentState: this.state,
        intent,
        action: transition.action,
        activeTask: this.activeTask,
        activeProposal: this.activeProposal
      };
    }

    // If only tool result occurred AFTER last assistant turn:
    if (activeToolTurn) {
      return {
        previousState: this.state,
        currentState: this.state,
        intent: Intents.TOOL_RESULT,
        action: Actions.SILENT_ACK,
        activeTask: this.activeTask,
        activeProposal: this.activeProposal
      };
    }

    // Default fallback
    return {
      previousState: this.state,
      currentState: this.state,
      intent: Intents.UNKNOWN,
      action: Actions.NO_OP,
      activeTask: this.activeTask,
      activeProposal: this.activeProposal
    };
  }

  static broadcastToSlack(message) {
    if (!message) return;
    if (isDuplicateBroadcast('slack', message)) return;
    const OPENCLAW_BIN = process.env.OPENCLAW_BIN || '/home/long/.config/nvm/versions/node/v24.21.0/bin/openclaw';
    console.log('[FSM:SlackLog] (Out-of-band CLI disabled) ' + (message || '').slice(0, 100));
  }

  static broadcastToWhatsApp(message) {
    if (!message) return;
    if (isDuplicateBroadcast('whatsapp', message)) return;
    const OPENCLAW_BIN = process.env.OPENCLAW_BIN || '/home/long/.config/nvm/versions/node/v24.21.0/bin/openclaw';
    console.log('[FSM:WhatsAppLog] (Out-of-band CLI disabled) ' + (message || '').slice(0, 100));
  }
}
