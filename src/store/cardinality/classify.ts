// SPDX-License-Identifier: Apache-2.0
// Classifies attribute values (UUIDs, ids, URLs, IPs, ...) to spot likely high-cardinality dimensions.
// Character scans and anchored, linear regexes only, over at most MAX_CLASSIFIED_CHARS. Pure; no vscode import.

import { isIP } from 'net';
import { AttributeValue } from '../model';
import { DOMINANT_SHARE, VALUE_CLASSES, ValueClass } from './valueClass';

export const MAX_CLASSIFIED_CHARS = 256;
/** Unique values classified per key; later values only count. */
export const CLASSIFY_SAMPLE_LIMIT = 64;
const FREE_TEXT_MIN_CHARS = 24;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const SCHEME = /^[a-z][a-z0-9+.-]{0,15}:\/\//i;

const isDigitCode = (c: number) => c >= 48 && c <= 57;
const isHexCode = (c: number) => isDigitCode(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
const isUpperCode = (c: number) => c >= 65 && c <= 90;
const isLowerCode = (c: number) => c >= 97 && c <= 122;
const isSpaceCode = (c: number) => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x2028 || c === 0x2029;

export function isDigits(s: string): boolean {
  if (!s.length) return false;
  for (let i = 0; i < s.length; i++) if (!isDigitCode(s.charCodeAt(i))) return false;
  return true;
}

export function isNumericId(s: string, minDigits = 6): boolean {
  return s.length >= minDigits && isDigits(s);
}

export function isUuid(s: string): boolean {
  if (s.length !== 36) return false;
  for (let i = 0; i < 36; i++) {
    const c = s.charCodeAt(i);
    if (i === 8 || i === 13 || i === 18 || i === 23 ? c !== 45 : !isHexCode(c)) return false;
  }
  return true;
}

/** At least `minLen` hex digits (optional 0x), including a decimal digit so plain words don't match. */
export function isHexId(s: string, minLen = 16): boolean {
  const start = s.length > 2 && s.charCodeAt(0) === 48 && (s.charCodeAt(1) | 32) === 120 ? 2 : 0;
  if (s.length - start < minLen) return false;
  let digit = false;
  for (let i = start; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!isHexCode(c)) return false;
    if (isDigitCode(c)) digit = true;
  }
  return digit;
}

/** Epoch seconds, milliseconds, microseconds or nanoseconds between 2000 and 2100, or ISO 8601 with a time. */
export function isTimestamp(s: string): boolean {
  if (isDigits(s)) {
    if (s.length !== 10 && s.length !== 13 && s.length !== 16 && s.length !== 19) return false;
    const seconds = Number(s.slice(0, 10));
    return seconds >= 946_684_800 && seconds < 4_102_444_800;
  }
  return s.length >= 16 && s.length <= 40 && ISO_TIMESTAMP.test(s);
}

/** IPv4 or IPv6, optionally with a port (`1.2.3.4:80`, `[::1]:80`). */
export function isIpAddress(s: string): boolean {
  if (s.length < 2 || s.length > 47) return false;
  // Cheap filter before node's address regexes: hex digits, dots, colons and brackets only.
  let sep = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 46 || c === 58) sep = true;
    else if (!isHexCode(c) && c !== 91 && c !== 93) return false;
  }
  if (!sep) return false;
  if (isIP(s)) return true;
  if (s.charCodeAt(0) === 91) {
    const end = s.indexOf(']');
    return end > 0 && isIP(s.slice(1, end)) === 6 && isPortSuffix(s, end + 1);
  }
  const colon = s.lastIndexOf(':');
  return colon > 0 && isIP(s.slice(0, colon)) === 4 && isPortSuffix(s, colon);
}

function isPortSuffix(s: string, at: number): boolean {
  if (at === s.length) return true;
  return s.charCodeAt(at) === 58 && s.length - at - 1 <= 5 && isDigits(s.slice(at + 1));
}

export function isEmail(s: string): boolean {
  const at = s.indexOf('@');
  if (at < 1 || at > 64 || at !== s.lastIndexOf('@')) return false;
  let dot = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isSpaceCode(c) || c === 34 || c === 60 || c === 62) return false;
    if (i > at) {
      if (c === 46) {
        if (i === at + 1 || i === s.length - 1 || s.charCodeAt(i - 1) === 46) return false;
        dot = true;
      } else if (!(isDigitCode(c) || isLowerCode(c | 32) || c === 45)) {
        return false;
      }
    }
  }
  return dot;
}

/** Long random-looking token (API keys, base64, JWT): mixed case letters and digits, no spaces. */
export function isOpaqueToken(s: string): boolean {
  if (s.length < 20) return false;
  let digit = false;
  let upper = false;
  let lower = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isDigitCode(c)) digit = true;
    else if (isUpperCode(c)) upper = true;
    else if (isLowerCode(c)) lower = true;
    // _ - + / = . (base64, base64url, JWT)
    else if (c !== 95 && c !== 45 && c !== 43 && c !== 47 && c !== 61 && c !== 46) return false;
  }
  return digit && upper && lower;
}

/** A path segment that varies per entity. */
export function isIdSegment(seg: string): boolean {
  return isDigits(seg) || isUuid(seg) || isHexId(seg, 8) || isOpaqueToken(seg) || isEmail(seg);
}

/** Whether a name (span name, route) embeds an id in any space-, slash- or query-separated part. */
export function hasIdPart(name: string): boolean {
  const s = name.length > MAX_CLASSIFIED_CHARS ? name.slice(0, MAX_CLASSIFIED_CHARS) : name;
  for (const part of s.split(/[\s/?&=,]+/)) {
    if (part && (isIdSegment(part) || isIpAddress(part))) return true;
  }
  return false;
}

function classifyUrlLike(s: string): ValueClass | undefined {
  const scheme = SCHEME.exec(s);
  let pathStart: number;
  if (scheme) {
    const slash = s.indexOf('/', scheme[0].length);
    pathStart = slash < 0 ? s.length : slash;
  } else if (s.charCodeAt(0) === 47) {
    pathStart = 0;
  } else {
    return undefined;
  }
  const q = s.indexOf('?', pathStart);
  const hash = s.indexOf('#', pathStart);
  let pathEnd = q >= 0 ? q : hash;
  if (pathEnd < 0) pathEnd = s.length;
  if (q >= 0 && s.indexOf('=', q) > q) return 'urlQuery';
  for (const seg of s.slice(pathStart, pathEnd).split('/')) {
    if (seg && isIdSegment(seg)) return 'pathId';
  }
  return 'other';
}

export function classifyString(value: string): ValueClass {
  const s = value.length > MAX_CLASSIFIED_CHARS ? value.slice(0, MAX_CLASSIFIED_CHARS) : value;
  if (!s) return 'other';
  if (isUuid(s)) return 'uuid';
  if (isTimestamp(s)) return 'timestamp';
  for (let i = 0; i < s.length; i++) {
    if (isSpaceCode(s.charCodeAt(i))) return value.length >= FREE_TEXT_MIN_CHARS ? 'freeText' : 'other';
  }
  if (isIpAddress(s)) return 'ip';
  if (isEmail(s)) return 'email';
  const url = classifyUrlLike(s);
  if (url) return url;
  if (isNumericId(s)) return 'numericId';
  if (isHexId(s)) return 'hexId';
  if (isOpaqueToken(s)) return 'token';
  return 'other';
}

export function classifyValue(v: AttributeValue): ValueClass {
  if (typeof v === 'string') return classifyString(v);
  if (typeof v === 'number') return 'number';
  return 'other';
}

/** Class counts for one key's first CLASSIFY_SAMPLE_LIMIT unique values. */
export class ClassTally {
  private readonly counts = new Uint8Array(VALUE_CLASSES.length);
  private n = 0;

  get total(): number {
    return this.n;
  }

  get full(): boolean {
    return this.n >= CLASSIFY_SAMPLE_LIMIT;
  }

  add(cls: ValueClass): void {
    if (this.full) return;
    this.counts[VALUE_CLASSES.indexOf(cls)]++;
    this.n++;
  }

  /** The class covering at least DOMINANT_SHARE of the samples, if any. */
  dominant(): ValueClass | undefined {
    if (!this.n) return undefined;
    let best = 0;
    for (let i = 1; i < this.counts.length; i++) if (this.counts[i] > this.counts[best]) best = i;
    return this.counts[best] / this.n >= DOMINANT_SHARE ? VALUE_CLASSES[best] : undefined;
  }

  /** Non-zero classes, most frequent first (ties in VALUE_CLASSES order). */
  entries(): [ValueClass, number][] {
    const out: [ValueClass, number][] = [];
    for (let i = 0; i < this.counts.length; i++) if (this.counts[i]) out.push([VALUE_CLASSES[i], this.counts[i]]);
    return out.sort((a, b) => b[1] - a[1]);
  }
}
