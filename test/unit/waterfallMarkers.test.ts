import * as assert from 'assert';
import { bucketLogMarkers, severityBucket } from '../../src/views/webview/waterfallMarkers';

const log = (seq: number, offsetMs: number, severityNumber = 9) => ({ seq, offsetMs, severityNumber });

describe('waterfallMarkers', () => {
  it('returns nothing for no logs', () => {
    assert.deepStrictEqual(bucketLogMarkers([], 0, 10, 100), []);
  });

  it('positions logs as a percentage of trace time', () => {
    const [m] = bucketLogMarkers([log(1, 25)], 0, 100, 200);
    assert.strictEqual(m.pct, 12.5);
    assert.strictEqual(m.count, 1);
    assert.strictEqual(m.clamped, false);
  });

  it('merges logs in the same bucket and rolls up severity', () => {
    const markers = bucketLogMarkers([log(1, 10, 9), log(2, 10.2, 17), log(3, 60, 13)], 0, 100, 100);
    assert.deepStrictEqual(
      markers.map((m) => [m.count, m.maxSeverity, m.seqs]),
      [
        [2, 17, [1, 2]],
        [1, 13, [3]],
      ]
    );
  });

  it('clamps skewed logs to the span edges and flags them', () => {
    const markers = bucketLogMarkers([log(1, -5), log(2, 500)], 10, 20, 100);
    assert.deepStrictEqual(
      markers.map((m) => [m.pct, m.clamped]),
      [
        [10, true],
        [30, true],
      ]
    );
  });

  it('coarsens buckets beyond the per-bar maximum', () => {
    const many = Array.from({ length: 400 }, (_, i) => log(i, i / 4));
    const markers = bucketLogMarkers(many, 0, 100, 100, 0.5, 50);
    assert.ok(markers.length <= 50);
    assert.strictEqual(
      markers.reduce((n, m) => n + m.count, 0),
      400
    );
  });

  it('handles a zero-duration span and a zero-length trace', () => {
    const [m] = bucketLogMarkers([log(1, 3), log(2, 9)], 5, 0, 10);
    assert.strictEqual(m.pct, 50);
    assert.strictEqual(m.count, 2);
    assert.strictEqual(bucketLogMarkers([log(1, 0)], 0, 0, 0)[0].pct, 0);
  });

  it('maps severity numbers to classes', () => {
    assert.strictEqual(severityBucket(21), 'error');
    assert.strictEqual(severityBucket(13), 'warn');
    assert.strictEqual(severityBucket(9), 'info');
    assert.strictEqual(severityBucket(0), 'debug');
  });
});
