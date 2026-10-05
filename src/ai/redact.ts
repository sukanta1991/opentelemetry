// SPDX-License-Identifier: Apache-2.0
// Masks secrets in telemetry before it reaches a language model. Always returns deep copies,
// never mutates store-owned objects. Patterns are fixed and bounded; no user-supplied regex.

import { AttributeValue, KeyValueMap } from '../store/model';
import { setOwn } from './serialize';

export const REDACTED = '[REDACTED]';

const BUILTIN_KEYS = [
  'authorization',
  'auth',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apikey',
  'accesskey',
  'privatekey',
  'credential',
  'session',
  'connectionstring',
  'dbconnectionstring',
  'xapikey',
];

const MAX_DEPTH = 32;

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s._-]/g, '');
}

// Structural fields keep their value when it has the expected shape.
const HEX_ID = /^[0-9a-f]{1,32}$/i;
const isHexId = (v: unknown) => typeof v === 'string' && HEX_ID.test(v);
const isString = (v: unknown) => typeof v === 'string';
const isNumber = (v: unknown) => typeof v === 'number';
const STRUCTURAL = new Map<string, (v: unknown) => boolean>([
  ['traceId', isHexId],
  ['spanId', isHexId],
  ['parentSpanId', isHexId],
  ['instanceId', isString],
  ['seq', isNumber],
  ['filepath', isString],
  ['line', isNumber],
  ['column', isNumber],
]);

type Replacer = [RegExp, string];

const VALUE_RULES: Replacer[] = [
  [
    /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[A-Za-z0-9+/=\s]{0,20000}(?:-----END [A-Z ]{0,40}PRIVATE KEY-----)?/g,
    '[REDACTED PRIVATE KEY]',
  ],
  [/\b(Bearer)[ \t]{1,10}[A-Za-z0-9._~+/=-]{8,65536}/gi, `$1 ${REDACTED}`],
  // Case-sensitive: lowercase "basic" is a common English word in log text.
  [/\bBasic[ \t]{1,10}[A-Za-z0-9+/=]{8,65536}/g, `Basic ${REDACTED}`],
  // Lookbehind (not \b) so only the start of a run can begin a match; keeps scanning linear.
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,65536}\.[A-Za-z0-9_-]{5,65536}\.[A-Za-z0-9_-]{0,65536}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,255}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,255}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,255}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,255}/g, REDACTED],
  [/\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/?#@]{1,256}):[^\s/?#@]{1,256}@/gi, `$1:${REDACTED}@`],
];

// key=value / key: value pairs (query strings, connection strings, JSON-ish text). Only the
// key and separator are consumed per match, so a non-sensitive pair can't hide a later one.
const PAIR_KEY = /(^|[?&;,\s{("'])([A-Za-z][\w.-]{0,63})(["']?[ \t]{0,3}[=:][ \t]{0,3}["']?)/g;
const PAIR_VALUE = /[^\s;,&"'}]{1,65536}/y;

function redactPairs(s: string, isSensitiveKey: (k: string) => boolean): string {
  const keyRe = new RegExp(PAIR_KEY);
  const valueRe = new RegExp(PAIR_VALUE);
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(s))) {
    if (!isSensitiveKey(m[2])) continue;
    const end = m.index + m[0].length;
    valueRe.lastIndex = end;
    const v = valueRe.exec(s);
    if (!v) continue;
    out += s.slice(last, end) + REDACTED;
    last = end + v[0].length;
    keyRe.lastIndex = last;
  }
  return last ? out + s.slice(last) : s;
}

export interface Redactor {
  attrs(map: KeyValueMap): KeyValueMap;
  text(s: string): string;
  value<T = AttributeValue>(v: T): T;
}

export function createRedactor(extraKeys: readonly string[] = []): Redactor {
  const keys = [...BUILTIN_KEYS];
  for (const k of extraKeys) {
    const n = typeof k === 'string' ? normalizeKey(k) : '';
    if (n && !keys.includes(n)) keys.push(n);
  }
  const isSensitiveKey = (key: string): boolean => {
    const n = normalizeKey(key);
    // "tokens" is a GenAI usage count (input_tokens, max_tokens), not a credential.
    const forToken = n.replace(/tokens/g, '');
    return keys.some((p) => (p === 'token' ? forToken : n).includes(p));
  };
  const text = (s: string): string => {
    let out = s;
    for (const [re, rep] of VALUE_RULES) out = out.replace(re, rep);
    return redactPairs(out, isSensitiveKey);
  };

  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') return text(v);
    if (v === null || typeof v !== 'object') return v;
    if (depth >= MAX_DEPTH) return '[depth]';
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src)) {
      const child = src[k];
      let next: unknown;
      if (STRUCTURAL.get(k)?.(child)) next = child;
      else if (isSensitiveKey(k)) next = REDACTED;
      else next = walk(child, depth + 1);
      setOwn(out, k, next);
    }
    return out;
  };

  return {
    attrs: (map) => walk(map, 0) as KeyValueMap,
    text,
    value: <T>(v: T) => walk(v, 0) as T,
  };
}
