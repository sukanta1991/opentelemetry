import * as assert from 'assert';
import {
  TRACE_COLUMNS,
  isTraceColumnId,
  traceColumnDef,
} from '../../src/views/webview/traceColumns';
import {
  TraceRow,
  compareTraces,
  defaultTracesPanelState,
  loadTracesPanelState,
  moveTraceColumn,
  nextSortDir,
  sanitizeAttrKeys,
  sanitizeQueryInput,
  setTraceColumnVisibility,
  setTraceColumnWidth,
  sortTraces,
  traceCellText,
  visibleAttrKeys,
} from '../../src/views/webview/traceView';

function row(id: string, over: Partial<TraceRow> = {}): TraceRow {
  return {
    traceId: id,
    rootName: 'op',
    rootService: 'svc',
    startMs: 0,
    durationMs: 0,
    spanCount: 1,
    errorCount: 0,
    services: ['svc'],
    ...over,
  };
}

describe('traceColumns', () => {
  it('has unique ids and recognises attribute columns', () => {
    const ids = TRACE_COLUMNS.map((c) => c.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    assert.ok(isTraceColumnId('duration'));
    assert.ok(isTraceColumnId('attr:http.route'));
    assert.ok(!isTraceColumnId('attr:'));
    assert.ok(!isTraceColumnId('level'));
    assert.strictEqual(traceColumnDef('attr:http.route').label, 'http.route');
    assert.strictEqual(traceColumnDef('attr:http.route').group, 'attributes');
  });
});

describe('traceView sorting', () => {
  const rows = [
    row('c', { startMs: 30, durationMs: 5, rootName: 'b', rootAttrs: { n: '10' } }),
    row('a', { startMs: 10, durationMs: 50, rootName: 'a', errorCount: 2, rootAttrs: { n: '9' } }),
    row('b', { startMs: 20, durationMs: 5, rootName: 'C', logCount: 3 }),
  ];
  const order = (col: Parameters<typeof nextSortDir>[1], dir: 'asc' | 'desc') =>
    sortTraces(rows.slice(), { col, dir }).map((r) => r.traceId);

  it('sorts numerically', () => {
    assert.deepStrictEqual(order('start', 'desc'), ['c', 'b', 'a']);
    assert.deepStrictEqual(order('duration', 'desc'), ['a', 'b', 'c'], 'ties broken by trace id');
    assert.deepStrictEqual(order('errors', 'desc'), ['a', 'b', 'c']);
    assert.deepStrictEqual(order('logs', 'desc'), ['b', 'a', 'c']);
  });

  it('sorts text case-insensitively and numeric attributes numerically', () => {
    assert.deepStrictEqual(order('root', 'asc'), ['a', 'c', 'b']);
    assert.deepStrictEqual(order('attr:n', 'asc'), ['b', 'a', 'c']);
  });

  it('breaks ties by trace id in both directions', () => {
    assert.strictEqual(compareTraces(row('a'), row('b'), { col: 'spans', dir: 'desc' }) < 0, true);
  });

  it('starts numeric and time columns descending', () => {
    assert.deepStrictEqual(nextSortDir({ col: 'start', dir: 'desc' }, 'duration'), { col: 'duration', dir: 'desc' });
    assert.deepStrictEqual(nextSortDir({ col: 'start', dir: 'desc' }, 'root'), { col: 'root', dir: 'asc' });
    assert.deepStrictEqual(nextSortDir({ col: 'root', dir: 'asc' }, 'root'), { col: 'root', dir: 'desc' });
  });
});

describe('traceView cell text', () => {
  it('formats each column', () => {
    const r = row('t', { startMs: 0, durationMs: 1500, errorCount: 1, services: ['a', 'b'], rootAttrs: { k: 'v' } });
    assert.strictEqual(traceCellText(r, 'status'), 'Error');
    assert.strictEqual(traceCellText(row('t'), 'status'), '');
    assert.strictEqual(traceCellText(r, 'start'), '1970-01-01T00:00:00.000Z');
    assert.strictEqual(traceCellText(r, 'duration'), '1.50s');
    assert.strictEqual(traceCellText(r, 'services'), 'a, b');
    assert.strictEqual(traceCellText(r, 'attr:k'), 'v');
    assert.strictEqual(traceCellText(r, 'attr:missing'), '');
    assert.strictEqual(traceCellText(r, 'logs'), '');
  });
});

describe('traceView query input', () => {
  it('sanitises untrusted input', () => {
    const s = sanitizeQueryInput({
      service: 5,
      name: 'x'.repeat(2000),
      status: 'boom',
      kind: 'server',
      minMs: -1,
      maxMs: 20,
      range: 'forever',
      query: 'dur>1s',
    });
    assert.strictEqual(s.service, '');
    assert.strictEqual(s.name.length, 1000);
    assert.strictEqual(s.status, '');
    assert.strictEqual(s.kind, 'server');
    assert.strictEqual(s.minMs, null);
    assert.strictEqual(s.maxMs, 20);
    assert.strictEqual(s.range, '5m');
    assert.strictEqual(s.query, 'dur>1s');
    assert.deepStrictEqual(sanitizeQueryInput(null), defaultTracesPanelState().input);
  });

  it('bounds visible attribute keys', () => {
    assert.deepStrictEqual(sanitizeAttrKeys(['a', 'a', '', 3, 'b']), ['a', 'b']);
    assert.strictEqual(sanitizeAttrKeys(Array.from({ length: 40 }, (_, i) => `k${i}`)).length, 20);
    assert.deepStrictEqual(sanitizeAttrKeys('a'), []);
  });
});

describe('traceView persisted state', () => {
  it('round-trips and validates', () => {
    const state = defaultTracesPanelState();
    state.sort = { col: 'duration', dir: 'asc' };
    state.columns = setTraceColumnVisibility(state.columns, 'attr:http.route', true);
    state.input.query = 'status=error';
    state.showLogs = false;
    assert.deepStrictEqual(loadTracesPanelState(JSON.parse(JSON.stringify(state))), state);
  });

  it('falls back to defaults for junk and unknown versions', () => {
    assert.deepStrictEqual(loadTracesPanelState(undefined), defaultTracesPanelState());
    assert.deepStrictEqual(loadTracesPanelState({ v: 9 }), defaultTracesPanelState());
    const s = loadTracesPanelState({ v: 1, columns: [{ id: 'bogus' }, { id: 'root', visible: true, width: 5 }], sort: 'x' });
    assert.strictEqual(s.columns[0].id, 'root');
    assert.strictEqual(s.columns[0].width, 50, 'clamped to min width');
    assert.strictEqual(s.columns.length, TRACE_COLUMNS.length, 'missing columns appended');
    assert.deepStrictEqual(s.sort, defaultTracesPanelState().sort);
  });

  it('column reducers and visible attribute keys', () => {
    let c = setTraceColumnVisibility(defaultTracesPanelState().columns, 'attr:a', true);
    c = setTraceColumnVisibility(c, 'attr:b', true);
    c = setTraceColumnVisibility(c, 'attr:b', false);
    assert.deepStrictEqual(visibleAttrKeys(c), ['a']);
    assert.strictEqual(setTraceColumnWidth(c, 'root', 10).find((x) => x.id === 'root')?.width, 50);
    assert.strictEqual(moveTraceColumn(c, 'attr:a', 'status', false)[0].id, 'attr:a');
  });
});
