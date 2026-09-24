import * as assert from 'assert';
import {
  DEFAULT_TIME_RANGE,
  TIME_RANGE_LABEL,
  TIME_RANGE_OPTIONS,
  TIME_RANGE_SECONDS,
  isTimeRangeKind,
  windowBounds,
} from '../../src/views/webview/timeRange';
import { LOG_RANGE_LABEL, LOG_RANGE_OPTIONS, isLogRangeKind } from '../../src/views/webview/logView';

describe('timeRange', () => {
  it('has a label and duration for every option', () => {
    for (const r of TIME_RANGE_OPTIONS) {
      assert.ok(TIME_RANGE_LABEL[r]);
      assert.ok(TIME_RANGE_SECONDS[r] > 0);
    }
    assert.ok(TIME_RANGE_OPTIONS.includes(DEFAULT_TIME_RANGE));
  });

  it('validates range kinds without matching inherited keys', () => {
    assert.ok(isTimeRangeKind('15m'));
    assert.ok(isTimeRangeKind('all'));
    assert.ok(!isTimeRangeKind('3m'));
    assert.ok(!isTimeRangeKind('toString'));
    assert.ok(!isTimeRangeKind(5));
  });

  it('anchors the window to the newest record', () => {
    assert.deepStrictEqual(windowBounds(600_000, '5m'), [300_000, Infinity]);
    assert.deepStrictEqual(windowBounds(600_000, 'all'), [-Infinity, Infinity]);
  });

  it('falls back to the wall clock with no records', () => {
    const before = Date.now();
    const [from] = windowBounds(0, '1m');
    assert.ok(from >= before - 60_000 && from <= Date.now() - 60_000);
  });

  it('is re-exported unchanged by the logs view', () => {
    assert.strictEqual(LOG_RANGE_OPTIONS, TIME_RANGE_OPTIONS);
    assert.strictEqual(LOG_RANGE_LABEL.all, 'All logs');
    assert.strictEqual(LOG_RANGE_LABEL['5m'], TIME_RANGE_LABEL['5m']);
    assert.strictEqual(isLogRangeKind, isTimeRangeKind);
  });
});
