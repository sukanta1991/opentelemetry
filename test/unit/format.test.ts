// SPDX-License-Identifier: Apache-2.0
import * as assert from 'assert';
import { formatTimestamp } from '../../src/views/format';

// Fixes the offset formatTimestamp reads, so these cases run the same in any machine timezone.
function withTimezoneOffset<T>(minutesWest: number, fn: () => T): T {
  const original = Date.prototype.getTimezoneOffset;
  Date.prototype.getTimezoneOffset = () => minutesWest;
  try {
    return fn();
  } finally {
    Date.prototype.getTimezoneOffset = original;
  }
}

describe('timestamp formatting', () => {
  it('formats UTC timestamps as ISO strings', () => {
    assert.strictEqual(formatTimestamp(0, false), '1970-01-01T00:00:00.000Z');
  });

  it('formats local timestamps with their numeric UTC offset', () => {
    const date = new Date(0);
    const offset = -date.getTimezoneOffset();
    const sign = offset < 0 ? '-' : '+';
    const pad = (value: number) => String(value).padStart(2, '0');
    const expected =
      `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.000` +
      `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
    assert.strictEqual(formatTimestamp(0, true), expected);
  });

  it('writes positive, negative and half-hour offsets', () => {
    // getTimezoneOffset() counts minutes west of UTC, so India (+05:30) is -330.
    const cases: [number, string][] = [
      [-330, '1970-01-01T05:30:00.000+05:30'], // India
      [-345, '1970-01-01T05:45:00.000+05:45'], // Nepal
      [300, '1969-12-31T19:00:00.000-05:00'], // New York, winter
      [210, '1969-12-31T20:30:00.000-03:30'], // Newfoundland, winter
      [0, '1970-01-01T00:00:00.000+00:00'],
    ];
    for (const [minutesWest, expected] of cases) {
      assert.strictEqual(withTimezoneOffset(minutesWest, () => formatTimestamp(0, true)), expected);
    }
  });
});
