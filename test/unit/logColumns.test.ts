import * as assert from 'assert';
import {
  ATTR_COLUMN_PREFIX,
  LOG_COLUMNS,
  MIN_COL_WIDTH,
  attrColumnId,
  columnDef,
  columnLabel,
  isAttrColumn,
  isLogColumnId,
  isSortable,
  parseAttrColumn,
} from '../../src/views/webview/logColumns';

describe('logColumns registry', () => {
  it('defaults to the pre-migration visible set and widths', () => {
    const visible = LOG_COLUMNS.filter((c) => c.defaultVisible);
    assert.deepStrictEqual(
      visible.map((c) => c.id),
      ['time', 'level', 'message', 'attributes']
    );
    assert.deepStrictEqual(
      visible.map((c) => c.defaultWidth),
      [200, 70, 480, 360]
    );
  });

  it('exposes every planned column exactly once', () => {
    const ids = LOG_COLUMNS.map((c) => c.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'duplicate column id');
    for (const id of [
      'time',
      'observedTime',
      'level',
      'severityNumber',
      'message',
      'attributes',
      'traceId',
      'spanId',
      'scope',
      'codeLocation',
      'function',
      'select',
    ]) {
      assert.ok(ids.includes(id as never), `missing column ${id}`);
    }
  });

  it('marks only time, observedTime, level and severityNumber as sortable', () => {
    const sortable = LOG_COLUMNS.filter((c) => c.sortable).map((c) => c.id);
    assert.deepStrictEqual(sortable.sort(), ['level', 'observedTime', 'severityNumber', 'time']);
  });

  it('round-trips attribute column ids, including keys containing a colon', () => {
    for (const key of ['http.method', 'a:b:c', 'k', 'x=1']) {
      assert.strictEqual(parseAttrColumn(attrColumnId(key)), key);
    }
  });

  it('recognises attribute columns and rejects the bare prefix', () => {
    assert.ok(isAttrColumn('attr:http.method'));
    assert.ok(!isAttrColumn(ATTR_COLUMN_PREFIX));
    assert.ok(!isAttrColumn('time'));
    assert.strictEqual(parseAttrColumn('time'), undefined);
  });

  it('validates column ids', () => {
    assert.ok(isLogColumnId('message'));
    assert.ok(isLogColumnId('attr:foo'));
    assert.ok(!isLogColumnId('nope'));
    assert.ok(!isLogColumnId(42));
    assert.ok(!isLogColumnId(undefined));
  });

  it('synthesises a definition for dynamic attribute columns', () => {
    const def = columnDef('attr:http.status_code');
    assert.strictEqual(def.group, 'attributes');
    assert.strictEqual(def.label, 'http.status_code');
    assert.strictEqual(def.defaultVisible, false);
    assert.strictEqual(def.minWidth, MIN_COL_WIDTH);
    assert.ok(def.sortable, 'attribute columns are sortable');
    assert.strictEqual(columnLabel('attr:http.status_code'), 'http.status_code');
    assert.ok(isSortable('attr:anything'));
    assert.ok(!isSortable('message'));
  });
});
