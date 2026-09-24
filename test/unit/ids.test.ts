import * as assert from 'assert';
import { normalizeSpanId, normalizeTraceId } from '../../src/store/ids';

const TRACE = '0af7651916cd43dd8448eb211c80319c';
const SPAN = 'b7ad6b7169203331';

describe('ids', () => {
  it('passes canonical ids through', () => {
    assert.strictEqual(normalizeTraceId(TRACE), TRACE);
    assert.strictEqual(normalizeSpanId(SPAN), SPAN);
  });

  it('lowercases and strips 0x, dashes and whitespace', () => {
    assert.strictEqual(normalizeTraceId(TRACE.toUpperCase()), TRACE);
    assert.strictEqual(normalizeTraceId(`0x${TRACE}`), TRACE);
    assert.strictEqual(normalizeTraceId('0af76519-16cd-43dd-8448-eb211c80319c'), TRACE);
    assert.strictEqual(normalizeSpanId(`  ${SPAN.toUpperCase()}  `), SPAN);
    assert.strictEqual(normalizeSpanId(`0X${SPAN}`), SPAN);
  });

  it('rejects all-zero ids', () => {
    assert.strictEqual(normalizeTraceId('0'.repeat(32)), undefined);
    assert.strictEqual(normalizeSpanId('0'.repeat(16)), undefined);
  });

  it('rejects wrong length and non-hex', () => {
    assert.strictEqual(normalizeTraceId(SPAN), undefined);
    assert.strictEqual(normalizeSpanId(TRACE), undefined);
    assert.strictEqual(normalizeSpanId('b7ad6b716920333g'), undefined);
    assert.strictEqual(normalizeTraceId(''), undefined);
  });

  it('rejects non-string input', () => {
    assert.strictEqual(normalizeTraceId(undefined), undefined);
    assert.strictEqual(normalizeTraceId(null), undefined);
    assert.strictEqual(normalizeTraceId(123), undefined);
    assert.strictEqual(normalizeSpanId({}), undefined);
  });
});
