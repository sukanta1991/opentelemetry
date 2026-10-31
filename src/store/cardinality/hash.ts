// SPDX-License-Identifier: Apache-2.0
// Seeded 32-bit hashing of attribute values for cardinality counting. Pure; no vscode import.

import { randomBytes } from 'crypto';
import { byCodeUnit } from '../../compare';
import { AttributeValue } from '../model';

/** Only this many UTF-16 units are hashed; the full length is still mixed in. */
export const MAX_HASHED_CHARS = 1024;
const MAX_DEPTH = 8;
const MAX_OBJECT_KEYS = 1024;

// Random per process so crafted values can't be made to collide (hash flooding).
export const PROCESS_SEED = randomBytes(4).readUInt32LE(0);

// Per-type seed tweaks keep "1", 1 and ["1"] distinct.
const TAG_SCALAR = 0x9e3779b9;
const TAG_NULL = 0x7f4a7c15;
const TAG_STRUCT = 0x632be59b;

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

/** MurmurHash3 (x86, 32-bit) over UTF-16 code units, two units per block. Returns an unsigned 32-bit int. */
export function hashString(s: string, seed: number): number {
  const n = Math.min(s.length, MAX_HASHED_CHARS);
  let h = seed | 0;
  let i = 0;
  for (; i + 1 < n; i += 2) {
    let k = s.charCodeAt(i) | (s.charCodeAt(i + 1) << 16);
    k = Math.imul(k, C1);
    k = (k << 15) | (k >>> 17);
    h ^= Math.imul(k, C2);
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  if (i < n) {
    let k = Math.imul(s.charCodeAt(i), C1);
    k = (k << 15) | (k >>> 17);
    h ^= Math.imul(k, C2);
  }
  h ^= s.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash of one attribute value; equal values (objects compared by sorted keys) hash equally. */
export function hashValue(v: AttributeValue, seed: number): number {
  if (typeof v === 'string') return hashString(v, seed);
  if (v === null || v === undefined) return hashString('', seed ^ TAG_NULL);
  if (typeof v !== 'object') return hashString(String(v), seed ^ TAG_SCALAR);
  return hashString(stableJson(v), seed ^ TAG_STRUCT);
}

// Key-sorted JSON that stops growing once it passes MAX_HASHED_CHARS, so huge values cost bounded work.
function stableJson(v: AttributeValue): string {
  const out: string[] = [];
  let len = 0;
  const push = (s: string): void => {
    out.push(s);
    len += s.length;
  };
  const write = (x: AttributeValue, depth: number): void => {
    if (len > MAX_HASHED_CHARS) return;
    if (typeof x === 'string') {
      // Length first, so it lands inside the hashed prefix.
      push(x.length > MAX_HASHED_CHARS ? `${x.length}#${JSON.stringify(x.slice(0, MAX_HASHED_CHARS))}` : JSON.stringify(x));
    } else if (x === null || typeof x !== 'object') {
      push(JSON.stringify(x) ?? 'null');
    } else if (depth >= MAX_DEPTH) {
      push('"[depth]"');
    } else if (Array.isArray(x)) {
      push('[');
      for (let i = 0; i < x.length && len <= MAX_HASHED_CHARS; i++) {
        if (i) push(',');
        write(x[i], depth + 1);
      }
      push(']');
    } else {
      const keys = Object.keys(x);
      if (keys.length > MAX_OBJECT_KEYS) keys.length = MAX_OBJECT_KEYS;
      keys.sort(byCodeUnit);
      push('{');
      for (let i = 0; i < keys.length && len <= MAX_HASHED_CHARS; i++) {
        push(`${i ? ',' : ''}${JSON.stringify(keys[i])}:`);
        write(x[keys[i]], depth + 1);
      }
      push('}');
    }
  };
  write(v, 0);
  return out.join('');
}
