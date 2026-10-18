// JSON.parse silently collapses duplicate object member names, including
// escaped spellings of the same decoded name. Evidence is used to bind remote
// execution results to a lease and must have one unambiguous interpretation.
// Number() can round a non-integer token to an integer (for example
// `1.00000000000000000001` to 1 or `1e-400` to 0). Integer identity checks
// must not accept such tokens merely because the resulting Number is safe.
export const MAX_STRICT_JSON_BYTES = 32 * 1024 * 1024;

function integerTokenMatchesNumber(token, value) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) return false;
  const fraction = match[3] || '';
  const digits = match[2] + fraction;
  if (/^0+$/.test(digits)) return value === 0;

  const exponent = Number(match[4] || '0');
  if (!Number.isSafeInteger(exponent)) return false;
  const scale = fraction.length - exponent;
  if (!Number.isSafeInteger(scale)) return false;

  let integerDigits;
  if (scale > 0) {
    // A nonzero value smaller than one, or with nonzero fractional digits,
    // cannot exactly represent the integer produced by Number().
    if (scale >= digits.length) return false;
    const fractionalDigits = digits.slice(digits.length - scale);
    if (!/^0+$/.test(fractionalDigits)) return false;
    integerDigits = digits.slice(0, digits.length - scale);
  } else {
    const significantDigits = digits.replace(/^0+/, '');
    const appendedZeros = -scale;
    // Any accepted integer must fit in Number's safe-integer range, which has
    // at most 16 decimal digits. Bound work before constructing appended zeros.
    if (significantDigits.length + appendedZeros > 16) return false;
    integerDigits = significantDigits + '0'.repeat(appendedZeros);
  }

  const magnitudeDigits = integerDigits.replace(/^0+/, '') || '0';
  const magnitude = Number(magnitudeDigits);
  if (!Number.isSafeInteger(magnitude)) return false;
  const exactInteger = match[1] === '-' ? -magnitude : magnitude;
  return exactInteger === value;
}

export function parseStrictJson(input, label = 'JSON evidence') {
  let text;
  if (typeof input === 'string') {
    if (input.length > MAX_STRICT_JSON_BYTES || Buffer.byteLength(input, 'utf8') > MAX_STRICT_JSON_BYTES) {
      throw new Error(`${label} exceeds the ${MAX_STRICT_JSON_BYTES}-byte limit`);
    }
    text = input;
  } else {
    if (!input || typeof input.byteLength !== 'number') throw new Error(`${label} input must be a string or byte buffer`);
    if (input.byteLength > MAX_STRICT_JSON_BYTES) throw new Error(`${label} exceeds the ${MAX_STRICT_JSON_BYTES}-byte limit`);
    try {
      // Preserve a leading BOM in the decoded string so the JSON grammar below
      // rejects it rather than silently normalizing byte-input differently
      // from string-input (JSON.parse rejects the same leading code point).
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input);
    } catch (error) {
      throw new Error(`${label} is not valid UTF-8: ${error.message}`);
    }
  }
  if (text.length > MAX_STRICT_JSON_BYTES) {
    // UTF-8 byte input can decode to one UTF-16 code unit per byte at most,
    // but keep the post-decode check explicit as a parser work bound.
    throw new Error(`${label} exceeds the ${MAX_STRICT_JSON_BYTES}-byte limit`);
  }
  let index = 0;
  let nodes = 0;
  const fail = message => { throw new SyntaxError(`${label} is invalid at byte/character offset ${index}: ${message}`); };
  const whitespace = () => { while (index < text.length && [' ', '\t', '\r', '\n'].includes(text[index])) index++; };
  const parseString = () => {
    const start = index;
    if (text[index] !== '"') fail('expected a JSON string');
    index++;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index++;
        try {
          const decoded = JSON.parse(text.slice(start, index));
          for (let cursor = 0; cursor < decoded.length; cursor++) {
            const code = decoded.charCodeAt(cursor);
            if (code >= 0xd800 && code <= 0xdbff) {
              const next = decoded.charCodeAt(cursor + 1);
              if (!(next >= 0xdc00 && next <= 0xdfff)) fail('unpaired high surrogate in string');
              cursor++;
            } else if (code >= 0xdc00 && code <= 0xdfff) {
              fail('unpaired low surrogate in string');
            }
          }
          return decoded;
        }
        catch { fail('invalid JSON string escape'); }
      }
      if (character.charCodeAt(0) < 0x20) fail('unescaped control character in string');
      if (character === '\\') {
        index++;
        if (index >= text.length) fail('truncated string escape');
        const escape = text[index];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 1, index + 5))) fail('invalid Unicode escape');
          index += 5;
          continue;
        }
        if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(escape)) fail('invalid string escape');
      }
      index++;
    }
    fail('unterminated JSON string');
  };
  const parseValue = depth => {
    whitespace();
    if (depth > 256) fail('maximum nesting depth exceeded');
    if (++nodes > 1_000_000) fail('maximum JSON node count exceeded');
    const character = text[index];
    if (character === '"') return parseString();
    if (character === '{') {
      index++;
      whitespace();
      const object = {};
      const keys = new Set();
      if (text[index] === '}') { index++; return object; }
      while (index < text.length) {
        whitespace();
        const key = parseString();
        if (keys.has(key)) fail(`duplicate decoded object key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        if (text[index] !== ':') fail('expected colon after object key');
        index++;
        const value = parseValue(depth + 1);
        Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
        whitespace();
        if (text[index] === '}') { index++; return object; }
        if (text[index] !== ',') fail('expected comma or closing brace');
        index++;
      }
      fail('unterminated JSON object');
    }
    if (character === '[') {
      index++;
      whitespace();
      const array = [];
      if (text[index] === ']') { index++; return array; }
      while (index < text.length) {
        array.push(parseValue(depth + 1));
        whitespace();
        if (text[index] === ']') { index++; return array; }
        if (text[index] !== ',') fail('expected comma or closing bracket');
        index++;
      }
      fail('unterminated JSON array');
    }
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, index)) { index += literal.length; return value; }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
    if (number) {
      index += number[0].length;
      const value = Number(number[0]);
      if (!Number.isFinite(value)) fail('number is outside the supported finite range');
      // String(-0) is "0", so identity comparisons that stringify parsed IDs
      // would otherwise erase the sign and alias a distinct input token.
      if (Object.is(value, -0)) fail('negative zero is not supported');
      // JSON's number grammar permits arbitrary precision, but JavaScript
      // silently rounds integer-valued numbers outside the safe range. These
      // values commonly represent run IDs, attempts, and other identity-bearing
      // evidence. Reject them rather than allowing two distinct JSON tokens to
      // collapse to the same in-memory number.
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        fail('integer is outside the supported safe integer range');
      }
      if (Number.isInteger(value) && !integerTokenMatchesNumber(number[0], value)) {
        fail('integer-valued number token is not exactly represented');
      }
      return value;
    }
    fail('expected a JSON value');
  };
  const value = parseValue(0);
  whitespace();
  if (index !== text.length) fail('trailing content after the JSON value');
  return value;
}
