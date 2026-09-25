// Canonical trace/span id form: lowercase hex, with the W3C all-zero "invalid" id treated as absent.

const ZERO = /^0+$/;

function normalizeHex(v: unknown, length: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  let s = v.trim();
  if (s.startsWith('0x') || s.startsWith('0X')) s = s.slice(2);
  s = s.replace(/[-\s]/g, '').toLowerCase();
  if (s.length !== length || !/^[0-9a-f]+$/.test(s) || ZERO.test(s)) return undefined;
  return s;
}

export function normalizeTraceId(v: unknown): string | undefined {
  return normalizeHex(v, 32);
}

export function normalizeSpanId(v: unknown): string | undefined {
  return normalizeHex(v, 16);
}
