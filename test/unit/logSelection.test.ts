import * as assert from 'assert';
import {
  WireLog,
  pruneSelection,
  rangeSelection,
} from '../../src/views/webview/logView';

function wl(seq: number): WireLog {
  return { seq, timeMs: seq * 1000, severityNumber: 9, severityText: 'INFO', body: '', attrs: {} };
}

// View order after a newest-first sort.
const rows = [wl(5), wl(4), wl(3), wl(2), wl(1)];

describe('range selection', () => {
  it('selects inclusively in view order', () => {
    assert.deepStrictEqual(rangeSelection(rows, 4, 2), [4, 3, 2]);
  });

  it('is direction agnostic', () => {
    assert.deepStrictEqual(rangeSelection(rows, 2, 4), [4, 3, 2]);
  });

  it('selects a single row when both ends match', () => {
    assert.deepStrictEqual(rangeSelection(rows, 3, 3), [3]);
  });

  it('spans the whole view', () => {
    assert.deepStrictEqual(rangeSelection(rows, 5, 1), [5, 4, 3, 2, 1]);
  });

  it('returns nothing when an endpoint is filtered out', () => {
    assert.deepStrictEqual(rangeSelection(rows, 99, 2), []);
    assert.deepStrictEqual(rangeSelection(rows, 2, 99), []);
    assert.deepStrictEqual(rangeSelection([], 1, 2), []);
  });

  it('follows the given order rather than seq order', () => {
    const shuffled = [wl(2), wl(9), wl(4)];
    assert.deepStrictEqual(rangeSelection(shuffled, 2, 4), [2, 9, 4]);
  });
});

describe('selection pruning', () => {
  it('drops seqs no longer retained', () => {
    const selection = new Set([1, 2, 3]);
    pruneSelection(selection, new Set([2, 3, 4]));
    assert.deepStrictEqual([...selection], [2, 3]);
  });

  it('accepts a Map of records as the live set', () => {
    const selection = new Set([1, 2]);
    const live = new Map<number, WireLog>([[2, wl(2)]]);
    pruneSelection(selection, live);
    assert.deepStrictEqual([...selection], [2]);
  });

  it('is a no-op when everything is still live', () => {
    const selection = new Set([1, 2]);
    pruneSelection(selection, new Set([1, 2, 3]));
    assert.deepStrictEqual([...selection], [1, 2]);
  });

  it('empties the selection when nothing survives', () => {
    const selection = new Set([1, 2]);
    pruneSelection(selection, new Set<number>());
    assert.strictEqual(selection.size, 0);
  });
});
