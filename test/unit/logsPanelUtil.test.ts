import * as assert from 'assert';
import { getLogTimeMs, sortRowsByLogTime } from '../../src/utils/logsPanelUtil';

describe('logsPanelUtil', () => {
  it('prefers timeMs when available', () => {
    const log = { timeMs: 500, observedTimeMs: 1000 } as any;
    assert.strictEqual(getLogTimeMs(log), 500);
  });

  it('uses observedTimeMs when timeMs is missing', () => {
    const log = { observedTimeMs: 1000 } as any;
    assert.strictEqual(getLogTimeMs(log), 1000);
  });

  it('returns zero when no timestamp is present', () => {
    const log = {} as any;
    assert.strictEqual(getLogTimeMs(log), 0);
  });

  it('sorts rows by the log capture time', () => {
    const logs = [
      { timeMs: 300 } as any,
      { observedTimeMs: 100 } as any,
      { timeMs: 200 } as any,
    ];
    const rows = [{ i: 0 }, { i: 1 }, { i: 2 }];
    const sorted = sortRowsByLogTime(rows, logs);
    assert.deepStrictEqual(sorted.map((r: { i: number }) => r.i), [1, 2, 0]);
  });
});
