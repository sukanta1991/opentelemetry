import * as assert from 'assert';
import {
  DEFAULT_DENSITY,
  DEFAULT_LOG_RANGE,
  DEFAULT_SORT,
  DENSITY_LABEL,
  DENSITY_LINE_CLAMP,
  DENSITY_OPTIONS,
  LOG_RANGE_OPTIONS,
  LogSort,
  WireLog,
  cellText,
  compareLogs,
  defaultLogsPanelState,
  filterLogs,
  isLogDensity,
  isLogRangeKind,
  loadLogsPanelState,
  logHaystack,
  logTimeMs,
  needsMoreRetention,
  newestTime,
  nextSortDir,
  oldestTime,
  severityClass,
  sortLogs,
  summarizeAttrs,
  windowBounds,
} from '../../src/views/webview/logView';
import { AttributeValue } from '../../src/store/model';

function wl(seq: number, over: Partial<WireLog> = {}): WireLog {
  return {
    seq,
    timeMs: seq * 1000,
    severityNumber: 9,
    severityText: 'INFO',
    body: `m${seq}`,
    attrs: {},
    ...over,
  };
}

function order(logs: WireLog[], sort: LogSort): number[] {
  return logs.slice().sort((a, b) => compareLogs(a, b, sort)).map((l) => l.seq);
}

describe('logView density and range', () => {
  it('validates density values', () => {
    assert.ok(isLogDensity('raw'));
    assert.ok(isLogDensity('condensed'));
    assert.ok(!isLogDensity('compact'));
    assert.ok(!isLogDensity(3));
    assert.strictEqual(DEFAULT_DENSITY, 'raw');
  });

  it('offers every range plus All, defaulting to 5m', () => {
    assert.deepStrictEqual(LOG_RANGE_OPTIONS, ['1m', '2m', '5m', '15m', '30m', '1h', '2h', 'all']);
    assert.strictEqual(DEFAULT_LOG_RANGE, '5m');
    assert.ok(isLogRangeKind('all'));
    assert.ok(!isLogRangeKind('3m'));
  });

  it('anchors the window to the newest record, not the wall clock', () => {
    const newest = 1_000_000;
    const [from, to] = windowBounds(newest, '1m');
    assert.strictEqual(from, newest - 60_000);
    assert.strictEqual(to, Infinity, 'future-dated records are never hidden');
  });

  it('treats All as unbounded', () => {
    assert.deepStrictEqual(windowBounds(1_000_000, 'all'), [-Infinity, Infinity]);
  });

  it('falls back to now when no record has been seen', () => {
    const [from] = windowBounds(0, '1m');
    assert.ok(from > Date.now() - 61_000 && from <= Date.now() - 59_000);
  });

  it('prefers timeMs but falls back to observedTimeMs', () => {
    assert.strictEqual(logTimeMs(wl(1, { timeMs: 5, observedTimeMs: 9 })), 5);
    assert.strictEqual(logTimeMs(wl(1, { timeMs: 0, observedTimeMs: 9 })), 9);
    assert.strictEqual(logTimeMs(wl(1, { timeMs: 0 })), 0);
  });
});

describe('logView sorting', () => {
  it('defaults to newest-first by time', () => {
    assert.deepStrictEqual(DEFAULT_SORT, { col: 'time', dir: 'desc' });
    const logs = [wl(1), wl(2), wl(3)];
    assert.deepStrictEqual(order(logs, DEFAULT_SORT), [3, 2, 1]);
    assert.deepStrictEqual(order(logs, { col: 'time', dir: 'asc' }), [1, 2, 3]);
  });

  it('sorts levels by severity number, not label', () => {
    const logs = [
      wl(1, { severityNumber: 17, severityText: 'ERROR' }),
      wl(2, { severityNumber: 5, severityText: 'DEBUG' }),
      wl(3, { severityNumber: 13, severityText: 'WARN' }),
    ];
    assert.deepStrictEqual(order(logs, { col: 'level', dir: 'asc' }), [2, 3, 1]);
    assert.deepStrictEqual(order(logs, { col: 'severityNumber', dir: 'desc' }), [1, 3, 2]);
  });

  it('sorts observedTime independently of time', () => {
    const logs = [
      wl(1, { timeMs: 3000, observedTimeMs: 1000 }),
      wl(2, { timeMs: 1000, observedTimeMs: 3000 }),
    ];
    assert.deepStrictEqual(order(logs, { col: 'observedTime', dir: 'asc' }), [1, 2]);
    assert.deepStrictEqual(order(logs, { col: 'time', dir: 'asc' }), [2, 1]);
  });

  it('tiebreaks on seq so equal keys keep a stable order', () => {
    const logs = [wl(3, { timeMs: 1000 }), wl(1, { timeMs: 1000 }), wl(2, { timeMs: 1000 })];
    assert.deepStrictEqual(order(logs, { col: 'time', dir: 'asc' }), [1, 2, 3]);
    assert.deepStrictEqual(order(logs, { col: 'time', dir: 'desc' }), [3, 2, 1]);
  });

  it('orders attribute values by type then value', () => {
    const a = (v: AttributeValue) => ({ attrs: { k: v } });
    const logs = [wl(1, a('b')), wl(2, a(10)), wl(3, a(true)), wl(4, a('a')), wl(5, a(2))];
    assert.deepStrictEqual(order(logs, { col: 'attr:k', dir: 'asc' }), [5, 2, 4, 1, 3]);
  });

  it('keeps logs missing the attribute last in both directions', () => {
    const logs = [wl(1, { attrs: {} }), wl(2, { attrs: { k: 'z' } }), wl(3, { attrs: { k: 'a' } })];
    assert.deepStrictEqual(order(logs, { col: 'attr:k', dir: 'asc' }), [3, 2, 1]);
    assert.deepStrictEqual(order(logs, { col: 'attr:k', dir: 'desc' }), [2, 3, 1]);
  });

  it('toggles direction on the active column and picks a sensible default otherwise', () => {
    assert.deepStrictEqual(nextSortDir({ col: 'time', dir: 'desc' }, 'time'), { col: 'time', dir: 'asc' });
    assert.deepStrictEqual(nextSortDir({ col: 'time', dir: 'asc' }, 'time'), { col: 'time', dir: 'desc' });
    assert.deepStrictEqual(nextSortDir({ col: 'time', dir: 'asc' }, 'level'), { col: 'level', dir: 'desc' });
    assert.deepStrictEqual(nextSortDir({ col: 'time', dir: 'asc' }, 'attr:k'), { col: 'attr:k', dir: 'asc' });
  });
});

describe('logView cell text', () => {
  const log = wl(1, {
    timeMs: 0,
    observedTimeMs: 1000,
    severityNumber: 17,
    severityText: '',
    body: { a: 1 },
    attrs: { 'http.method': 'GET', n: 3, flag: true },
    traceId: 'abc',
    spanId: 'def',
    scope: 'my.scope',
    codeLocation: { filepath: '/src/a.ts', line: 12, function: 'run' },
  });

  it('renders each column', () => {
    assert.strictEqual(cellText(log, 'time'), new Date(1000).toISOString());
    assert.strictEqual(cellText(log, 'observedTime'), new Date(1000).toISOString());
    assert.strictEqual(cellText(log, 'level'), 'ERROR', 'falls back to severityLabel');
    assert.strictEqual(cellText(log, 'severityNumber'), '17');
    assert.strictEqual(cellText(log, 'message'), '{"a":1}');
    assert.strictEqual(cellText(log, 'traceId'), 'abc');
    assert.strictEqual(cellText(log, 'spanId'), 'def');
    assert.strictEqual(cellText(log, 'scope'), 'my.scope');
    assert.strictEqual(cellText(log, 'codeLocation'), '/src/a.ts:12');
    assert.strictEqual(cellText(log, 'function'), 'run');
    assert.strictEqual(cellText(log, 'attr:http.method'), 'GET');
    assert.strictEqual(cellText(log, 'attr:n'), '3');
    assert.strictEqual(cellText(log, 'attr:flag'), 'true');
    assert.strictEqual(cellText(log, 'attr:absent'), '');
  });

  it('uses severityText when present and blanks missing optionals', () => {
    const plain = wl(2, { severityText: 'NOTICE', severityNumber: 10 });
    assert.strictEqual(cellText(plain, 'level'), 'NOTICE');
    assert.strictEqual(cellText(plain, 'observedTime'), '');
    assert.strictEqual(cellText(plain, 'traceId'), '');
    assert.strictEqual(cellText(plain, 'codeLocation'), '');
    assert.strictEqual(cellText(plain, 'function'), '');
  });

  it('summarises every attribute key, not just the first eight', () => {
    const attrs: Record<string, AttributeValue> = {};
    for (let i = 0; i < 12; i++) attrs[`k${i}`] = i;
    const out = summarizeAttrs(attrs);
    assert.ok(out.includes('k11=11'), 'ninth and later keys are retained');
    assert.strictEqual(out.split('  ').length, 12);
  });

  it('truncates an oversized attribute summary', () => {
    const attrs = { big: 'x'.repeat(2000) };
    const out = summarizeAttrs(attrs, 50);
    assert.strictEqual(out.length, 51);
    assert.ok(out.endsWith('…'));
  });

  it('returns an empty summary for no attributes', () => {
    assert.strictEqual(summarizeAttrs({}), '');
  });

  it('maps severity numbers to css classes', () => {
    assert.strictEqual(severityClass(21), 'sev-fatal');
    assert.strictEqual(severityClass(17), 'sev-error');
    assert.strictEqual(severityClass(13), 'sev-warn');
    assert.strictEqual(severityClass(9), '');
  });
});

describe('logView filter pipeline', () => {
  const f = (over: Partial<Parameters<typeof filterLogs>[1]> = {}) => ({
    query: '',
    level: 0,
    attrFilter: '',
    range: 'all' as const,
    ...over,
  });
  const ids = (rows: WireLog[]) => rows.map((l) => l.seq);

  const corpus: WireLog[] = [
    wl(1, { body: 'connection refused', severityNumber: 17, severityText: 'ERROR' }),
    wl(2, { body: 'request ok', severityNumber: 9, attrs: { 'http.method': 'GET' } }),
    wl(3, { body: 'cache miss', severityNumber: 5, severityText: 'DEBUG' }),
    wl(4, { body: 'request slow', severityNumber: 13, severityText: 'WARN', attrs: { 'http.method': 'POST' } }),
  ];

  it('passes everything through with an empty filter', () => {
    assert.deepStrictEqual(ids(filterLogs(corpus, f())), [1, 2, 3, 4]);
  });

  it('filters by minimum severity', () => {
    assert.deepStrictEqual(ids(filterLogs(corpus, f({ level: 13 }))), [1, 4]);
  });

  it('matches free text against body, attributes and severity', () => {
    assert.deepStrictEqual(ids(filterLogs(corpus, f({ query: 'request' }))), [2, 4]);
    assert.deepStrictEqual(ids(filterLogs(corpus, f({ query: 'http.method=get' }))), [2]);
    assert.deepStrictEqual(ids(filterLogs(corpus, f({ query: 'debug' }))), [3]);
  });

  it('is case-insensitive', () => {
    assert.deepStrictEqual(ids(filterLogs(corpus, f({ query: 'REFUSED' }))), [1]);
  });

  it('filters by attribute substring only against attributes', () => {
    assert.deepStrictEqual(ids(filterLogs(corpus, f({ attrFilter: 'http.method=POST' }))), [4]);
    assert.deepStrictEqual(ids(filterLogs(corpus, f({ attrFilter: 'request' }))), []);
  });

  it('combines every predicate', () => {
    assert.deepStrictEqual(
      ids(filterLogs(corpus, f({ query: 'request', level: 13, attrFilter: 'http.method' }))),
      [4]
    );
  });

  it('applies the time range anchored to the newest record', () => {
    // seq N has timeMs N*1000, so the newest is 4000.
    assert.deepStrictEqual(ids(filterLogs(corpus, f({ range: '1m' }))), [1, 2, 3, 4]);
    const spread = [wl(1, { timeMs: 0 }), wl(2, { timeMs: 100_000 }), wl(3, { timeMs: 160_000 })];
    assert.deepStrictEqual(ids(filterLogs(spread, f({ range: '1m' }))), [2, 3]);
    assert.deepStrictEqual(ids(filterLogs(spread, f({ range: 'all' }))), [1, 2, 3]);
  });

  it('uses the injected haystack resolver', () => {
    let calls = 0;
    const memo = new Map<number, ReturnType<typeof logHaystack>>();
    const resolver = (l: WireLog) => {
      let h = memo.get(l.seq);
      if (!h) {
        calls++;
        h = logHaystack(l);
        memo.set(l.seq, h);
      }
      return h;
    };
    filterLogs(corpus, f({ query: 'request' }), resolver);
    filterLogs(corpus, f({ query: 'slow' }), resolver);
    assert.strictEqual(calls, corpus.length, 'haystacks are built once per record');
  });

  it('reports the newest timestamp', () => {
    assert.strictEqual(newestTime(corpus), 4000);
    assert.strictEqual(newestTime([]), 0);
  });

  it('sorts in place after filtering', () => {
    const out = sortLogs(filterLogs(corpus, f({ level: 13 })), { col: 'time', dir: 'desc' });
    assert.deepStrictEqual(ids(out), [4, 1]);
  });
});

describe('logView density modes', () => {
  it('exposes the four modes in order with Raw first', () => {
    assert.deepStrictEqual(DENSITY_OPTIONS, ['raw', 'one', 'two', 'condensed']);
    assert.strictEqual(DEFAULT_DENSITY, 'raw');
  });

  it('clamps to the agreed line counts', () => {
    assert.strictEqual(DENSITY_LINE_CLAMP.raw, 0, 'raw is unclamped');
    assert.strictEqual(DENSITY_LINE_CLAMP.one, 1);
    assert.strictEqual(DENSITY_LINE_CLAMP.two, 2);
    assert.strictEqual(DENSITY_LINE_CLAMP.condensed, 4);
  });

  it('labels every mode', () => {
    for (const d of DENSITY_OPTIONS) assert.ok(DENSITY_LABEL[d].length > 0);
  });
});

describe('logView retention hint', () => {
  // History spans only one minute, so any window longer than that is under-served.
  const shortHistory = [
    wl(1, { timeMs: 600_000 }),
    wl(2, { timeMs: 630_000 }),
    wl(3, { timeMs: 660_000 }),
  ];
  // History reaches back well past a one-minute window.
  const longHistory = [wl(1, { timeMs: 0 }), wl(2, { timeMs: 660_000 })];

  it('stays hidden until records have actually been evicted', () => {
    assert.strictEqual(needsMoreRetention(shortHistory, '1h', false), false);
    assert.strictEqual(needsMoreRetention(shortHistory, '1h', true), true);
  });

  it('stays hidden when the buffer already covers the window', () => {
    assert.strictEqual(needsMoreRetention(longHistory, '1m', true), false);
  });

  it('never fires for the All range', () => {
    assert.strictEqual(needsMoreRetention(shortHistory, 'all', true), false);
  });

  it('is false with no logs', () => {
    assert.strictEqual(needsMoreRetention([], '1m', true), false);
  });

  it('uses the true oldest record, not arrival order', () => {
    const outOfOrder = [wl(1, { timeMs: 660_000 }), wl(2, { timeMs: 0 })];
    assert.strictEqual(oldestTime(outOfOrder), 0);
    assert.strictEqual(newestTime(outOfOrder), 660_000);
    assert.strictEqual(needsMoreRetention(outOfOrder, '1m', true), false, 'window is covered');
  });
});

describe('logView persisted state', () => {
  it('falls back to defaults for garbage input', () => {
    const base = defaultLogsPanelState();
    assert.deepStrictEqual(loadLogsPanelState(undefined), base);
    assert.deepStrictEqual(loadLogsPanelState(null), base);
    assert.deepStrictEqual(loadLogsPanelState('nope'), base);
    assert.deepStrictEqual(loadLogsPanelState({ v: 2, density: 'huge', range: '3m' }).density, 'raw');
  });

  it('migrates v1 column widths onto the new schema', () => {
    const st = loadLogsPanelState({ colWidths: { 'col-msg': 700, 'col-attrs': 250 } });
    const byId = new Map(st.columns.map((c) => [c.id, c]));
    assert.strictEqual(byId.get('message')?.width, 700);
    assert.strictEqual(byId.get('attributes')?.width, 250);
    assert.strictEqual(byId.get('time')?.width, 200, 'untouched columns keep defaults');
    assert.strictEqual(st.v, 2);
  });

  it('round-trips a v2 state', () => {
    const saved = {
      v: 2,
      columns: [
        { id: 'message', visible: true, width: 500 },
        { id: 'attr:http.method', visible: true, width: 120 },
      ],
      density: 'condensed',
      range: 'all',
      sort: { col: 'level', dir: 'asc' },
      query: 'boom',
      level: 13,
      attrFilter: 'k=v',
    };
    const st = loadLogsPanelState(saved);
    assert.strictEqual(st.density, 'condensed');
    assert.strictEqual(st.range, 'all');
    assert.deepStrictEqual(st.sort, { col: 'level', dir: 'asc' });
    assert.strictEqual(st.query, 'boom');
    assert.strictEqual(st.level, 13);
    assert.strictEqual(st.attrFilter, 'k=v');
    assert.strictEqual(st.columns[0].id, 'message', 'persisted order is preserved');
    assert.strictEqual(st.columns[1].id, 'attr:http.method');
  });

  it('drops unknown column ids and appends columns added later', () => {
    const st = loadLogsPanelState({
      v: 2,
      columns: [
        { id: 'bogus', visible: true, width: 100 },
        { id: 'message', visible: true, width: 500 },
        { id: 'message', visible: false, width: 10 },
      ],
    });
    const ids = st.columns.map((c) => c.id);
    assert.ok(!ids.includes('bogus' as never));
    assert.strictEqual(ids.filter((i) => i === 'message').length, 1, 'duplicates collapsed');
    assert.ok(ids.includes('time'), 'missing columns appended with defaults');
    assert.strictEqual(st.columns.find((c) => c.id === 'message')?.width, 500);
  });

  it('clamps persisted widths to the column minimum', () => {
    const st = loadLogsPanelState({ v: 2, columns: [{ id: 'message', visible: true, width: 5 }] });
    assert.strictEqual(st.columns[0].width, 60);
  });

  it('rejects an invalid persisted sort', () => {
    assert.deepStrictEqual(loadLogsPanelState({ v: 2, sort: { col: 'time', dir: 'sideways' } }).sort, DEFAULT_SORT);
    assert.deepStrictEqual(loadLogsPanelState({ v: 2, sort: { col: 'bogus', dir: 'asc' } }).sort, DEFAULT_SORT);
  });
});
