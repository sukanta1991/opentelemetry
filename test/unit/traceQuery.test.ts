import * as assert from 'assert';
import { Span } from '../../src/store/model';
import { TaggedSpan } from '../../src/store/store';
import { MAX_CLAUSES, matchesTrace, parseDurationMs, parseTraceQuery } from '../../src/views/traceQuery';
import { TraceQueryInput, TraceRow, defaultQueryInput } from '../../src/views/webview/traceView';

const TRACE = 'abcdef0123456789abcdef0123456789';

function tagged(over: Partial<Span> & { spanId: string }, serviceName = 'front'): TaggedSpan {
  return {
    serviceName,
    instanceId: `${serviceName}::i`,
    span: {
      traceId: TRACE,
      name: over.spanId,
      kind: 'INTERNAL',
      startMs: 0,
      endMs: 10,
      durationMs: 10,
      statusCode: 'UNSET',
      attrs: {},
      events: [],
      links: [],
      ...over,
    },
  };
}

const row: TraceRow = {
  traceId: TRACE,
  rootName: 'GET /api',
  rootService: 'front',
  startMs: 0,
  durationMs: 250,
  spanCount: 3,
  errorCount: 1,
  services: ['back', 'front'],
};

const spans: TaggedSpan[] = [
  tagged({ spanId: 'root', name: 'GET /api', kind: 'SERVER', attrs: { 'http.route': '/api', 'http.status_code': 500 } }),
  tagged(
    {
      spanId: 'db',
      name: 'SELECT users',
      kind: 'CLIENT',
      statusCode: 'ERROR',
      attrs: { 'db.system': 'Postgres', 'gen_ai.system': 'OpenAI', tokens: 42, tags: ['Alpha', 'beta'], flag: null },
    },
    'back'
  ),
  tagged({ spanId: 'cache', name: 'cache get', attrs: { 'cache.hit': true, retries: '3' } }),
];

function run(over: Partial<TraceQueryInput>, r: TraceRow = row) {
  const { query, errors } = parseTraceQuery({ ...defaultQueryInput(), ...over });
  return { match: matchesTrace(spans, r, query), errors };
}

const q = (query: string) => run({ query }).match;

describe('traceQuery', () => {
  it('matches everything with an empty query', () => {
    assert.strictEqual(run({}).match, true);
    assert.deepStrictEqual(run({}).errors, []);
  });

  describe('span-level terms', () => {
    it('service = / !=', () => {
      assert.strictEqual(q('service=back'), true);
      assert.strictEqual(q('service=BACK'), true);
      assert.strictEqual(q('service=nope'), false);
      assert.strictEqual(q('service!=front'), true);
    });

    it('name: contains, name= exact', () => {
      assert.strictEqual(q('name:select'), true);
      assert.strictEqual(q('name="select users"'), true);
      assert.strictEqual(q('name=select'), false);
      assert.strictEqual(q('name!="GET /api"'), true);
    });

    it('status and kind', () => {
      assert.strictEqual(q('status=error'), true);
      assert.strictEqual(q('status=ok'), false);
      assert.strictEqual(q('kind=server'), true);
      assert.strictEqual(q('kind=producer'), false);
    });

    it('attribute presence and absence', () => {
      assert.strictEqual(q('http.route'), true);
      assert.strictEqual(q('has:tokens'), true);
      assert.strictEqual(q('has:missing'), false);
      assert.strictEqual(q('-http.route'), true, 'some span lacks it');
    });

    it('attribute contains and not-contains, case-insensitively', () => {
      assert.strictEqual(q('db.system=postgres'), true);
      assert.strictEqual(q('gen_ai.system=AI'), true);
      assert.strictEqual(q('gen_ai.system=anthropic'), false);
      assert.strictEqual(q('tags=alpha'), true);
      assert.strictEqual(q('db.system!=postgres'), true, 'spans without the key pass !=');
    });

    it('matches attribute keys exactly', () => {
      assert.strictEqual(q('GEN_AI.SYSTEM'), false);
      assert.strictEqual(q('gen_ai=openai'), false);
    });

    it('numeric comparisons, including numeric strings', () => {
      assert.strictEqual(q('http.status_code>=500'), true);
      assert.strictEqual(q('http.status_code<500'), false);
      assert.strictEqual(q('tokens>40'), true);
      assert.strictEqual(q('retries<=3'), true);
      assert.strictEqual(q('db.system>1'), false);
    });
  });

  describe('same-span semantics', () => {
    it('requires every span predicate to hold on one span', () => {
      assert.strictEqual(q('service=back status=error'), true);
      assert.strictEqual(q('service=front status=error'), false);
      assert.strictEqual(q('service=front db.system=postgres'), false);
      assert.strictEqual(q('kind=server http.status_code=500'), true);
    });

    it('applies across controls and the query bar', () => {
      assert.strictEqual(run({ service: 'back', query: 'tokens>1' }).match, true);
      assert.strictEqual(run({ service: 'front', query: 'tokens>1' }).match, false);
      assert.strictEqual(run({ status: 'error', attr: 'db.system=postgres' }).match, true);
      assert.strictEqual(run({ kind: 'server', attr: 'db.system' }).match, false);
    });
  });

  describe('trace-level terms', () => {
    it('duration with units', () => {
      assert.strictEqual(q('dur>200ms'), true);
      assert.strictEqual(q('dur>0.3s'), false);
      assert.strictEqual(q('duration<1m'), true);
      assert.strictEqual(q('dur>=250'), true);
    });

    it('trace id contains', () => {
      assert.strictEqual(q('trace:abcdef01'), true);
      assert.strictEqual(q('traceid=ffff'), false);
    });

    it('min/max and trace id controls', () => {
      assert.strictEqual(run({ minMs: 250, maxMs: 250 }).match, true);
      assert.strictEqual(run({ minMs: 300 }).match, false);
      assert.strictEqual(run({ maxMs: 100 }).match, false);
      assert.strictEqual(run({ traceId: 'ABCDEF' }).match, true);
    });
  });

  describe('bare words', () => {
    it('match a span name or the trace id', () => {
      assert.strictEqual(q('users'), true);
      assert.strictEqual(q('"cache get"'), true);
      assert.strictEqual(q('abcdef'), true);
      assert.strictEqual(q('checkout'), false);
    });

    it('may be satisfied by different spans', () => {
      assert.strictEqual(q('users cache'), true);
    });
  });

  describe('attribute control', () => {
    it('keeps the legacy key / key=value semantics', () => {
      assert.strictEqual(run({ attr: 'tags' }).match, true);
      assert.strictEqual(run({ attr: 'flag' }).match, true);
      assert.strictEqual(run({ attr: 'missing' }).match, false);
      assert.strictEqual(run({ attr: 'k=' }).match, false);
      assert.strictEqual(run({ attr: 'db.system=' }).match, true);
    });

    it('accepts several comma- or space-separated terms', () => {
      assert.strictEqual(run({ attr: 'db.system=postgres, tokens=42' }).match, true);
      assert.strictEqual(run({ attr: 'db.system=postgres http.route' }).match, false);
    });

    it('keeps "=" inside a value', () => {
      const { query } = parseTraceQuery({ ...defaultQueryInput(), attr: 'url=a=b' });
      const s = [tagged({ spanId: 'x', attrs: { url: 'http://h/?a=b' } })];
      assert.strictEqual(matchesTrace(s, row, query), true);
    });
  });

  describe('quoting and errors', () => {
    it('supports quoted values with escapes', () => {
      const s = [tagged({ spanId: 'x', name: 'say "hi"' })];
      const { query, errors } = parseTraceQuery({ ...defaultQueryInput(), query: 'name="say \\"hi\\""' });
      assert.deepStrictEqual(errors, []);
      assert.strictEqual(matchesTrace(s, row, query), true);
    });

    it('reports invalid tokens but applies the rest', () => {
      const { match, errors } = run({ query: 'status=broken service=back dur>soon tokens>abc' });
      assert.strictEqual(match, true);
      assert.deepStrictEqual(
        errors.map((e) => e.token),
        ['status=broken', 'dur>soon', 'tokens>abc']
      );
    });

    it('reports an unterminated quote', () => {
      assert.ok(run({ query: 'name="oops' }).errors.some((e) => e.message === 'unterminated quote'));
    });

    it('caps the number of terms', () => {
      const words = Array.from({ length: MAX_CLAUSES + 5 }, () => 'users').join(' ');
      const { errors } = run({ query: `${words} checkout` });
      assert.ok(errors.some((e) => e.message.includes(`first ${MAX_CLAUSES}`)));
      assert.strictEqual(run({ query: `${words} checkout` }).match, true, 'term past the cap is ignored');
    });

    it('truncates overly long input', () => {
      const { errors } = run({ query: `${'x'.repeat(1200)}` });
      assert.ok(errors.some((e) => e.message.includes('truncated')));
    });
  });

  it('parses durations', () => {
    assert.strictEqual(parseDurationMs('250'), 250);
    assert.strictEqual(parseDurationMs('1.5s'), 1500);
    assert.strictEqual(parseDurationMs('2m'), 120_000);
    assert.strictEqual(parseDurationMs('500us'), 0.5);
    assert.strictEqual(parseDurationMs('fast'), undefined);
  });
});
