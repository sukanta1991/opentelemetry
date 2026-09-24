import * as assert from 'assert';
import {
  ColumnState,
  attrColumnId,
  isAttrColumn,
  moveColumn,
  parseAttrColumn,
  setColumnVisibility,
  setColumnWidth,
} from '../../src/views/webview/columnState';

type Id = 'a' | 'b' | 'c' | `attr:${string}`;

const cols = (): ColumnState<Id>[] => [
  { id: 'a', visible: true, width: 100 },
  { id: 'b', visible: false, width: 80 },
  { id: 'c', visible: true, width: 120 },
];

describe('columnState', () => {
  it('toggles visibility and appends unknown columns only when shown', () => {
    assert.strictEqual(setColumnVisibility(cols(), 'b', true, 50)[1].visible, true);
    const added = setColumnVisibility(cols(), attrColumnId('k'), true, 150);
    assert.deepStrictEqual(added[3], { id: 'attr:k', visible: true, width: 150 });
    assert.strictEqual(setColumnVisibility(cols(), attrColumnId('k'), false, 150).length, 3);
  });

  it('clamps and rounds widths', () => {
    assert.strictEqual(setColumnWidth(cols(), 'a', 10, 60)[0].width, 60);
    assert.strictEqual(setColumnWidth(cols(), 'a', 200.6, 60)[0].width, 201);
  });

  it('moves a column before or after a target', () => {
    const ids = (c: ColumnState<Id>[]) => c.map((x) => x.id);
    assert.deepStrictEqual(ids(moveColumn(cols(), 'c', 'a', false)), ['c', 'a', 'b']);
    assert.deepStrictEqual(ids(moveColumn(cols(), 'a', 'c', true)), ['b', 'c', 'a']);
    assert.deepStrictEqual(ids(moveColumn(cols(), 'a', 'a', true)), ['a', 'b', 'c']);
    assert.deepStrictEqual(ids(moveColumn(cols(), 'a', 'attr:x', true)), ['a', 'b', 'c']);
  });

  it('does not mutate its input', () => {
    const input = cols();
    setColumnVisibility(input, 'b', true, 50);
    setColumnWidth(input, 'a', 300, 60);
    moveColumn(input, 'c', 'a', false);
    assert.deepStrictEqual(input, cols());
  });

  it('round-trips attribute column ids, including keys with colons', () => {
    assert.strictEqual(parseAttrColumn(attrColumnId('ns:key')), 'ns:key');
    assert.ok(isAttrColumn('attr:x'));
    assert.ok(!isAttrColumn('attr:'));
    assert.strictEqual(parseAttrColumn('time'), undefined);
  });
});
