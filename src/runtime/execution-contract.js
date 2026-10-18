import {
  validateDurableExecutionRequest,
  validateDurableExecutionResult,
  DurableExecutionResultStatus
} from '../../protocol/cos-ap-v1/index.js';

export const ExecutionContractVersion = 1;
export const ExecutionResultStatus = DurableExecutionResultStatus;
export const validateExecutionRequest = validateDurableExecutionRequest;
export const validateExecutionResult = validateDurableExecutionResult;

function cloneJsonValue(value, label, stack = new Set(), budget = { nodes: 0 }) {
  if (++budget.nodes > 1_000_000) throw new TypeError(`${label} exceeds the JSON node limit`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new TypeError(`${label} contains a non-canonical number`);
    }
    return value;
  }
  if (!value || typeof value !== 'object') throw new TypeError(`${label} contains a value that is not JSON-safe`);
  if (stack.has(value)) throw new TypeError(`${label} contains a cyclic reference`);
  if (stack.size >= 256) throw new TypeError(`${label} exceeds the maximum JSON nesting depth`);
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      const extras = keys.filter(key => key !== 'length' &&
        !(typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length && String(Number(key)) === key));
      if (extras.length) throw new TypeError(`${label} contains unsupported array properties`);
      const output = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
          throw new TypeError(`${label} contains a sparse or accessor-backed array entry at index ${index}`);
        }
        output.push(cloneJsonValue(descriptor.value, `${label}[${index}]`, stack, budget));
      }
      return output;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError(`${label} must contain only plain JSON objects`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) throw new TypeError(`${label} contains symbol-keyed properties`);
    const output = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new TypeError(`${label}.${key} is not an enumerable data property`);
      }
      Object.defineProperty(output, key, {
        value: cloneJsonValue(descriptor.value, `${label}.${key}`, stack, budget),
        enumerable: true, writable: true, configurable: true
      });
    }
    return output;
  } finally {
    stack.delete(value);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

export function createExecutionRequest(input) {
  const snapshot = cloneJsonValue(input, 'execution request input');
  const request = { schema_version: ExecutionContractVersion, ...snapshot };
  return deepFreeze(validateExecutionRequest(request));
}

export function createExecutionResult(input) {
  const snapshot = cloneJsonValue(input, 'execution result input');
  const result = { schema_version: ExecutionContractVersion, ...snapshot };
  return deepFreeze(validateExecutionResult(result));
}
