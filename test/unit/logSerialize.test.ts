// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { StoredLogRecord } from '../../src/store/model';
import { formatTimestamp } from '../../src/views/format';
import { serializeLog } from '../../src/views/logSerialize';

const log: StoredLogRecord = {
  seq: 1,
  timeMs: 1000,
  observedTimeMs: 2000,
  severityNumber: 9,
  severityText: 'INFO',
  body: 'm1',
  attrs: {},
};

describe('serializeLog', () => {
  it('writes UTC times when local time is off', () => {
    const out = serializeLog(log, false);
    assert.strictEqual(out.time, new Date(1000).toISOString());
    assert.strictEqual(out.observedTime, new Date(2000).toISOString());
  });

  it('writes local times with their offset when local time is on', () => {
    const out = serializeLog(log, true);
    assert.strictEqual(out.time, formatTimestamp(1000, true));
    assert.strictEqual(out.observedTime, formatTimestamp(2000, true));
  });

  it('keeps the numeric times and omits a missing observed time', () => {
    const out = serializeLog({ ...log, observedTimeMs: undefined }, true);
    assert.strictEqual(out.timeMs, 1000);
    assert.strictEqual(out.observedTime, undefined);
    assert.strictEqual(out.observedTimeMs, undefined);
  });
});
