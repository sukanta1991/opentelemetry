import * as assert from 'assert';
import { ATTR_KEY_LIMIT, attrColumnId } from '../../src/views/webview/logColumns';
import {
  LogColumnState,
  WireLog,
  collectAttrKeys,
  defaultColumnState,
  moveColumn,
  setColumnVisibility,
  setColumnWidth,
} from '../../src/views/webview/logView';
import { AttributeValue } from '../../src/store/model';

function cols(...ids: string[]): LogColumnState[] {
  return ids.map((id) => ({ id: id as LogColumnState['id'], visible: true, width: 100 }));
}

function ids(list: readonly LogColumnState[]): string[] {
  return list.map((c) => c.id);
}

function wl(attrs: Record<string, AttributeValue>): WireLog {
  return { seq: 1, timeMs: 0, severityNumber: 9, severityText: 'INFO', body: '', attrs };
}

describe('column visibility reducer', () => {
  it('toggles an existing column without reordering', () => {
    const before = cols('time', 'level', 'message');
    const after = setColumnVisibility(before, 'level', false);
    assert.deepStrictEqual(ids(after), ['time', 'level', 'message']);
    assert.strictEqual(after[1].visible, false);
  });

  it('does not mutate the input', () => {
    const before = cols('time');
    setColumnVisibility(before, 'time', false);
    assert.strictEqual(before[0].visible, true);
  });

  it('appends an unknown column when turned on', () => {
    const after = setColumnVisibility(cols('time'), attrColumnId('http.method'), true);
    assert.deepStrictEqual(ids(after), ['time', 'attr:http.method']);
    assert.strictEqual(after[1].width, 160, 'attribute columns get the default width');
  });

  it('ignores an unknown column when turned off', () => {
    const after = setColumnVisibility(cols('time'), attrColumnId('nope'), false);
    assert.deepStrictEqual(ids(after), ['time']);
  });
});

describe('column width reducer', () => {
  it('sets and rounds a width', () => {
    const after = setColumnWidth(cols('message'), 'message', 321.6);
    assert.strictEqual(after[0].width, 322);
  });

  it('clamps to the column minimum', () => {
    assert.strictEqual(setColumnWidth(cols('message'), 'message', 5)[0].width, 60);
  });

  it('leaves other columns untouched', () => {
    const after = setColumnWidth(cols('time', 'message'), 'message', 300);
    assert.strictEqual(after[0].width, 100);
  });
});

describe('column reorder reducer', () => {
  const base = cols('time', 'level', 'message', 'attributes');

  it('moves a column before a target', () => {
    assert.deepStrictEqual(ids(moveColumn(base, 'message', 'time', false)), [
      'message',
      'time',
      'level',
      'attributes',
    ]);
  });

  it('moves a column after a target', () => {
    assert.deepStrictEqual(ids(moveColumn(base, 'time', 'message', true)), [
      'level',
      'message',
      'time',
      'attributes',
    ]);
  });

  it('moves a column to the very end', () => {
    assert.deepStrictEqual(ids(moveColumn(base, 'time', 'attributes', true)), [
      'level',
      'message',
      'attributes',
      'time',
    ]);
  });

  it('is a no-op when source and target match', () => {
    assert.deepStrictEqual(ids(moveColumn(base, 'level', 'level', false)), ids(base));
  });

  it('is a no-op for unknown ids', () => {
    assert.deepStrictEqual(ids(moveColumn(base, 'attr:nope', 'time', false)), ids(base));
    assert.deepStrictEqual(ids(moveColumn(base, 'time', 'attr:nope', false)), ids(base));
  });

  it('does not mutate the input', () => {
    moveColumn(base, 'message', 'time', false);
    assert.deepStrictEqual(ids(base), ['time', 'level', 'message', 'attributes']);
  });

  it('preserves hidden columns in the order', () => {
    const withHidden = defaultColumnState();
    const moved = moveColumn(withHidden, 'traceId', 'time', false);
    assert.strictEqual(moved.length, withHidden.length, 'no column is lost');
    const order = ids(moved);
    assert.strictEqual(order.indexOf('traceId'), order.indexOf('time') - 1);
    assert.ok(order.includes('severityNumber'), 'hidden columns survive the move');
  });
});

describe('attribute key collection', () => {
  it('accumulates keys across records', () => {
    const keys = new Set<string>();
    collectAttrKeys(keys, wl({ a: 1, b: 2 }));
    collectAttrKeys(keys, wl({ b: 3, c: 4 }));
    assert.deepStrictEqual([...keys].sort(), ['a', 'b', 'c']);
  });

  it('stops at the cap', () => {
    const keys = new Set<string>();
    const attrs: Record<string, AttributeValue> = {};
    for (let i = 0; i < 10; i++) attrs[`k${i}`] = i;
    collectAttrKeys(keys, wl(attrs), 4);
    assert.strictEqual(keys.size, 4);
  });

  it('short-circuits once the cap is reached', () => {
    const keys = new Set(['x', 'y']);
    collectAttrKeys(keys, wl({ z: 1 }), 2);
    assert.deepStrictEqual([...keys], ['x', 'y']);
  });

  it('defaults to the registry cap', () => {
    assert.strictEqual(ATTR_KEY_LIMIT, 500);
    const keys = new Set<string>();
    collectAttrKeys(keys, wl({ only: 1 }));
    assert.deepStrictEqual([...keys], ['only']);
  });

  it('handles a record with no attributes', () => {
    const keys = new Set<string>();
    collectAttrKeys(keys, wl({}));
    assert.strictEqual(keys.size, 0);
  });
});
